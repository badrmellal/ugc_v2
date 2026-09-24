# Omni UGC Studio

Generate 20-second vertical (9:16) UGC and science videos with **Gemini Omni 1.1 Flash** from one script and one character image.

Omni produces at most 10 seconds per request. This app generates the first 10 seconds, then **extends the same interaction** by another 10 seconds (`previous_interaction_id`), so the character, scene, voice, audio and motion carry over. You write one 20-second script; the backend splits it into two coherent 10-second instructions and returns one final 20-second MP4.

## Features

- **One script in, one 20s video out.** An LLM splitter (Gemini text model with a strict JSON schema, plus a deterministic fallback) divides the script at a natural boundary, keeps your dialogue verbatim, and writes a shared continuity bible (character, setting, voice, audio) that both turns repeat word for word.
- **Continuous extension.** Part 2 is generated as an extension of part 1's interaction. Omni returns the full combined 20s clip, which is verified with ffprobe. If a model ever returns only the new segment, the server stitches both parts automatically.
- **Character image per video.** Upload the character for each video and bind it as an identity reference (`<IMAGE_REF_0>`, default) or as the literal first frame (`<FIRST_FRAME>`). Images are sniffed, re-encoded and stripped of metadata before upload.
- **UGC and Scientific styles**, 360p / 720p / 1080p / 4k, language and voice direction, optional split review and editing before you spend anything.
- **Live progress**: stage stepper (split, upload, part 1, extension, finalize), percent and ETA, event log, and a part 1 preview as soon as the first 10 seconds exist.
- **Preview and download** in a phone-frame player with HTTP Range streaming (or presigned URLs from your bucket).
- **Regeneration**: full regeneration, "edit and regenerate", or **regenerate part 2 only** (keeps part 1 and re-runs only the extension, at roughly half the cost).
- **History** of every generation with thumbnails, status, duration and cost.
- **Cost control**: estimated cost before generating, actual cost computed from Gemini's reported token usage afterwards, an append-only spend ledger, and an optional daily budget cap.
- **Production-ready**: API key stays on the server, password or bearer-token auth, rate limits, Origin checks, security headers, Postgres-backed job queue with leases and crash recovery (a restarted worker resumes the same Gemini interaction instead of paying twice), S3-compatible storage, health checks, graceful shutdown, Docker image, CI.

## How it works

```
Browser (React)  ──>  API (Fastify)  ──>  Postgres (jobs, history, ledger)
                                   │                ▲
                                   ▼                │ lease + checkpoints
                     Object storage (local / S3)  <─┴─  Worker(s)
                                                        ├─ split script  (Gemini text model)
                                                        ├─ part 1: 0-10s  (Omni, character image, 9:16)
                                                        ├─ part 2: 10-20s (Omni, previous_interaction_id)
                                                        └─ verify + faststart + thumbnail (ffmpeg)
```

Each generation is both a history record and a job. Workers claim jobs with `FOR UPDATE SKIP LOCKED`, renew a lease with a heartbeat, and checkpoint every step (plan, uploaded image, interaction ids, stored videos). Gemini turns run in background mode and are polled, so a crash or deploy never loses a paid generation. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) and [docs/API.md](docs/API.md).

## Quick start (Docker)

```bash
cp .env.example .env
# edit .env: GEMINI_API_KEY, APP_PASSWORD, SESSION_SECRET (openssl rand -base64 48)
docker compose up --build
```

Open http://localhost:8080, sign in with `APP_PASSWORD`, paste a script, upload a character image, and generate.

## Local development

Requirements: Node.js 22.12+, PostgreSQL 14+, ffmpeg/ffprobe on `PATH`.

```bash
npm install
cp .env.example .env            # set GEMINI_API_KEY, or GEMINI_MOCK=true to work without a key
createdb omni_ugc               # or point DATABASE_URL at any Postgres
npm run dev                     # API + worker on :8080, Vite dev server on :5173
```

`GEMINI_MOCK=true` synthesizes videos locally with ffmpeg (no Google calls, no cost). It exercises the full pipeline, including the extension and finalize steps.

Scripts:

| Command | What it does |
| --- | --- |
| `npm run dev` | API + worker (tsx watch) and the Vite dev server with an `/api` proxy |
| `npm run build` | Builds the web app and the server |
| `npm start` | Runs the built server (serves the web app too) |
| `npm test` | Unit + integration tests (needs Postgres: `TEST_DATABASE_URL`, default `postgres://postgres:postgres@localhost:5432/omni_ugc_test`) |
| `npm run test:e2e` | Playwright end-to-end tests against the production build in mock mode |
| `npm run lint` / `npm run typecheck` / `npm run format` | Code quality |

## Configuration

All settings are environment variables; see [.env.example](.env.example) for the full list with comments. The important ones:

| Variable | Default | Notes |
| --- | --- | --- |
| `GEMINI_API_KEY` | | Required unless `GEMINI_MOCK=true`. Billing must be enabled (Omni has no free tier). |
| `OMNI_MODEL` | `gemini-omni-1.1-flash` | Video model. |
| `SPLITTER_MODEL` | `gemini-3.8-flash` | Text model that splits the script. |
| `APP_PASSWORD` / `SESSION_SECRET` | | UI login. Required in production (or `API_TOKENS`, or `AUTH_DISABLED=true` behind an auth proxy). |
| `API_TOKENS` | | Comma-separated bearer tokens for scripts and integrations. |
| `DATABASE_URL` | local Postgres | Migrations run automatically at startup. |
| `STORAGE_DRIVER` | `local` | `s3` for AWS S3, Google Cloud Storage (HMAC), Cloudflare R2, MinIO. |
| `ROLE` | `all` | `web`, `worker` or `all`. |
| `WORKER_CONCURRENCY` | `2` | Jobs per worker process. |
| `DAILY_BUDGET_USD` | unlimited | Blocks new jobs when today's spend plus in-flight estimates would exceed it. |
| `PRICE_*`, `VIDEO_TOKENS_PER_SEC_*` | Google list prices | Update if pricing changes. |

## Costs

Gemini Omni 1.1 Flash bills video output at **$17.50 per 1M tokens**, about **5,792 tokens per second at 720p (~$0.10/s)**; input is $1.50 per 1M tokens. A 20-second video is two turns:

| Resolution | Part 1 (10s) | Part 2 (extension) | Typical total |
| --- | --- | --- | --- |
| 360p | ~$0.34 | ~$0.34 to $0.68 | ~$0.70 to $1.05 |
| 720p | ~$1.01 | ~$1.01 to $2.03 | ~$2.10 to $3.15 |

Google does not document whether the extension turn bills only the new 10 seconds or the whole returned 20-second clip, so estimates default to the conservative case (`EXTENSION_BILLING=full_output`). After every turn the app records the **actual** cost from the token usage Gemini reports, and the generation page shows both. 1080p and 4k are upscaled outputs whose token rates are not published; their defaults are conservative and actual usage is always what gets recorded.

"Regenerate part 2 only" reuses part 1, so it costs only the extension turn.

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) for Google Cloud Run (web + always-on worker, Cloud SQL, Cloud Storage, Secret Manager), a single Docker host with `docker compose`, and Render.

## Good to know

- **Script length:** about 52 spoken words fit in 20 seconds (roughly 25 per part). Speech in each part ends before its last ~1.5 seconds so the seam between parts stays clean. The editor shows a pacing meter and the splitter warns when a script is too long.
- **Languages:** English is fully supported by Omni; other languages work but are not officially evaluated by Google.
- **Content policy:** Google blocks uploaded images of certain recognizable people (and images of minors in the EEA, Switzerland and the UK). A blocked request finishes without a video; the app reports it as `empty_output` or `safety_blocked` and does not retry.
- **Watermarking:** every Omni video carries an invisible SynthID watermark.
- **Retention:** Google keeps generated files for 48 hours (the worker copies them to your storage immediately) and interactions for 55 days (the window for "regenerate part 2 only").
- **Rate limits:** Google applies per-project spend-based limits over a rolling 10-minute window (for example $10 on Tier 1). The worker retries `429` responses with backoff; raise your tier for higher throughput.

## Project layout

```
server/            Fastify API, worker, pipeline, Gemini adapters (TypeScript)
  src/shared/      Types shared with the web app
  src/pipeline/    Job runner (checkpointed state machine) and worker
  src/gemini/      Omni + text model clients, mock client
  src/script/      Script splitter and prompt builders
  src/http/        Routes, auth, media streaming
web/               React + Vite + Tailwind single-page app
e2e/               Playwright end-to-end tests (mock mode)
docs/              Architecture, API reference, deployment
```
