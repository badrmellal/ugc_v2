# Deployment

The app ships as one Docker image. Run it as two processes in production:

- `ROLE=web`: API + web UI. Stateless, scale horizontally.
- `ROLE=worker`: generation jobs (Gemini calls, ffmpeg). Needs CPU while idle-polling Gemini, so it must not be CPU-throttled between requests.

Both need PostgreSQL 14+ and shared object storage (`STORAGE_DRIVER=s3`) unless they run on the same host with a shared volume (`STORAGE_DRIVER=local`).

Minimum production settings:

| Variable                         | Why                                                                                                |
| -------------------------------- | -------------------------------------------------------------------------------------------------- |
| `GEMINI_API_KEY`                 | Gemini API key with billing enabled (Omni has no free tier).                                       |
| `APP_PASSWORD`, `SESSION_SECRET` | Protect the UI. `SESSION_SECRET` must be 32+ random characters and the same on every web instance. |
| `DATABASE_URL`                   | PostgreSQL connection string.                                                                      |
| `STORAGE_DRIVER=s3` + `S3_*`     | Shared storage for videos and images.                                                              |
| `PUBLIC_ORIGIN`                  | The public URL, e.g. `https://ugc.example.com` (Origin check).                                     |
| `DAILY_BUDGET_USD`               | Recommended hard cap on daily spend.                                                               |

## Option A: Google Cloud Run (recommended)

Uses Cloud Run (web + worker), Cloud SQL for PostgreSQL, Cloud Storage through its S3-compatible XML API, and Secret Manager.

```bash
PROJECT=my-project
REGION=us-central1
gcloud config set project $PROJECT
gcloud services enable run.googleapis.com sqladmin.googleapis.com secretmanager.googleapis.com \
  artifactregistry.googleapis.com cloudbuild.googleapis.com

# 1. Build the image
gcloud artifacts repositories create omni --repository-format=docker --location=$REGION
IMAGE=$REGION-docker.pkg.dev/$PROJECT/omni/omni-ugc:$(git rev-parse --short HEAD)
gcloud builds submit --tag $IMAGE

# 2. Database
gcloud sql instances create omni-ugc-db --database-version=POSTGRES_16 --region=$REGION --tier=db-g1-small
gcloud sql databases create omni_ugc --instance=omni-ugc-db
gcloud sql users create omni --instance=omni-ugc-db --password="$(openssl rand -base64 24)"
# DATABASE_URL over the Cloud SQL unix socket:
#   postgres://omni:<password>@/omni_ugc?host=/cloudsql/$PROJECT:$REGION:omni-ugc-db

# 3. Storage bucket + HMAC key (S3 interoperability)
gcloud storage buckets create gs://$PROJECT-omni-ugc --location=$REGION --uniform-bucket-level-access
gcloud iam service-accounts create omni-ugc
SA=omni-ugc@$PROJECT.iam.gserviceaccount.com
gcloud storage buckets add-iam-policy-binding gs://$PROJECT-omni-ugc --member=serviceAccount:$SA --role=roles/storage.objectAdmin
gcloud storage hmac create $SA   # prints accessId and secret

# 4. Secrets
printf '%s' "<gemini-api-key>"        | gcloud secrets create gemini-api-key --data-file=-
printf '%s' "<ui-password>"           | gcloud secrets create app-password --data-file=-
openssl rand -base64 48 | tr -d '\n'  | gcloud secrets create session-secret --data-file=-
printf '%s' "<database-url>"          | gcloud secrets create database-url --data-file=-
printf '%s' "<hmac-access-id>"        | gcloud secrets create s3-access-key-id --data-file=-
printf '%s' "<hmac-secret>"           | gcloud secrets create s3-secret-access-key --data-file=-
for s in gemini-api-key app-password session-secret database-url s3-access-key-id s3-secret-access-key; do
  gcloud secrets add-iam-policy-binding $s --member=serviceAccount:$SA --role=roles/secretmanager.secretAccessor
done
gcloud projects add-iam-policy-binding $PROJECT --member=serviceAccount:$SA --role=roles/cloudsql.client

COMMON_ENV="NODE_ENV=production,STORAGE_DRIVER=s3,S3_BUCKET=$PROJECT-omni-ugc,S3_REGION=auto,S3_ENDPOINT=https://storage.googleapis.com,DAILY_BUDGET_USD=50"
COMMON_SECRETS="GEMINI_API_KEY=gemini-api-key:latest,DATABASE_URL=database-url:latest,S3_ACCESS_KEY_ID=s3-access-key-id:latest,S3_SECRET_ACCESS_KEY=s3-secret-access-key:latest"

# 5. Web service
gcloud run deploy omni-ugc-web --image=$IMAGE --region=$REGION --service-account=$SA \
  --add-cloudsql-instances=$PROJECT:$REGION:omni-ugc-db \
  --set-env-vars="$COMMON_ENV,ROLE=web" \
  --set-secrets="$COMMON_SECRETS,APP_PASSWORD=app-password:latest,SESSION_SECRET=session-secret:latest" \
  --allow-unauthenticated --memory=1Gi --cpu=1 --min-instances=0 --max-instances=5 --timeout=300
WEB_URL=$(gcloud run services describe omni-ugc-web --region=$REGION --format='value(status.url)')
gcloud run services update omni-ugc-web --region=$REGION --update-env-vars=PUBLIC_ORIGIN=$WEB_URL

# 6. Worker service (always-on CPU; one or more instances)
gcloud run deploy omni-ugc-worker --image=$IMAGE --region=$REGION --service-account=$SA \
  --add-cloudsql-instances=$PROJECT:$REGION:omni-ugc-db \
  --set-env-vars="$COMMON_ENV,ROLE=worker,WORKER_CONCURRENCY=2" \
  --set-secrets="$COMMON_SECRETS" \
  --no-allow-unauthenticated --no-cpu-throttling --min-instances=1 --max-instances=2 \
  --memory=2Gi --cpu=2
```

Notes:

- The worker listens on `PORT` and answers `/healthz` so Cloud Run can health-check it. Cloud Run worker pools are a good alternative for the worker if they are available in your region.
- Jobs are leased with a heartbeat. If an instance is replaced mid-job, another worker resumes it from the last checkpoint and polls the same Gemini interaction, so a restart never pays for the same turn twice.
- Presigned URLs (`S3_PRESIGNED_URLS=true`, default) let browsers stream videos straight from Cloud Storage. Set it to `false` to stream through the API instead.

## Option B: any Docker host (VM, bare metal)

```bash
cp .env.example .env    # set GEMINI_API_KEY, APP_PASSWORD, SESSION_SECRET, PUBLIC_ORIGIN
docker compose up -d --build
```

This runs Postgres, the web service on port 8080 and a worker, sharing a local volume for media. Put a TLS-terminating reverse proxy (Caddy, nginx, a cloud load balancer) in front of port 8080. Back up the `pgdata` and `storage` volumes.

## Option C: Render

`render.yaml` defines a Postgres database, the web service and a background worker. Render services do not share disks, so configure an S3-compatible bucket (`S3_*`). Create the Blueprint from the repository, then fill the `sync: false` variables (`GEMINI_API_KEY`, `APP_PASSWORD`, `S3_*`).

## Operations

- **Health:** `GET /healthz` (liveness), `GET /readyz` (database + storage).
- **Logs:** JSON (pino) on stdout, with `generationId` on every pipeline line. The API key is never logged.
- **Migrations:** run automatically at startup (`MIGRATE_ON_START=true`) under a Postgres advisory lock, so concurrent instances are safe. Manual: `npm run migrate --workspace server`.
- **Spend control:** `DAILY_BUDGET_USD` blocks new jobs when today's spend plus in-flight estimates would exceed it. Google also enforces spend-based rate limits per project (e.g. $10 per rolling 10 minutes on Tier 1); those surface as `rate_limited` and are retried with backoff.
- **Retention:** generated files stay in Google's Files API for 48 hours; the worker copies every output to your storage right away. Interactions are retained 55 days on the paid tier, which bounds how long "Regenerate part 2 only" stays available.
- **Scaling:** `OMNI_MAX_CONCURRENT_TURNS` (default 1) is the real throughput limit: it caps Omni turns running at once across all workers, because parallel streams on one API key are reported to get cut. With the default, one worker instance and `WORKER_CONCURRENCY=2` are enough (the second job plans and uploads while the first one generates). Raise the cap only after confirming your key handles parallel turns, then add worker concurrency or instances.
- **Transport:** turns stream by default (`OMNI_TRANSPORT=stream`). If Google rejects a transport the worker switches automatically and stores that decision in the `app_state` table for 7 days; delete the `omni_unsupported_transports` row to reset it.
