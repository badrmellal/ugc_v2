# Architecture

Omni UGC Studio turns one 20-second script plus one character image into one continuous 20-second vertical (9:16) video using Gemini Omni 1.1 Flash (`gemini-omni-1.1-flash`).

Omni generates at most 10 seconds per turn, so every video is produced in two turns of the **same interaction chain**:

1. **Part 1 (0-10s)**: `interactions.create` with the character image and the part 1 prompt, `response_format: { type: "video", aspect_ratio: "9:16", duration: "10s", resolution }`.
2. **Part 2 (10-20s)**: `interactions.create` with `previous_interaction_id = part1.id` and an "Extend this video..." prompt. Omni uses the previous turn's video, audio, voice and motion as context, so character, scene, voice and sound stay continuous.

The final file is verified with `ffprobe`. When the extension output already contains the full 20 seconds it is used as is (`assembly = model_full`). If the model only returned the new 10 seconds, the server stitches part 1 and part 2 with ffmpeg (`assembly = concatenated`).

## Components

```
browser (React SPA)
   │  cookie session / bearer token
   ▼
API (Fastify)  ──── Postgres ────  Worker(s)
   │                 ▲               │
   │                 │ leases,       ├── Script splitter (Gemini text model, JSON schema output)
   │                 │ checkpoints   ├── Gemini Omni client (Files API + Interactions API)
   ▼                 │               ├── ffmpeg / ffprobe (probe, concat, faststart, thumbnail)
Object storage (local disk or S3-compatible: S3, GCS, R2, MinIO)
```

The same Docker image runs as `ROLE=web`, `ROLE=worker` or `ROLE=all`.

### Server layout (`server/src`)

| Path            | Responsibility                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/api.ts` | Types and constants shared with the web app (DTOs, stages, limits). No Node imports.                                                               |
| `config.ts`     | Environment parsing and validation (zod). Single source of configuration.                                                                          |
| `core/ports.ts` | Interfaces between the pipeline and adapters (video model, text model, storage, media, records).                                                   |
| `db/`           | `pg` pool, embedded SQL migrations with an advisory-lock migrator, `GenerationRepository`.                                                         |
| `gemini/`       | `GeminiVideoClient` (Interactions + Files API via `@google/genai`), `GeminiTextClient`, `MockVideoClient`, `MockTextClient`, error classification. |
| `script/`       | Script splitter (LLM with strict JSON schema + deterministic fallback) and prompt builders for both turns.                                         |
| `pricing/`      | Cost estimate before generation and actual cost from reported token usage.                                                                         |
| `media/`        | ffmpeg/ffprobe wrappers.                                                                                                                           |
| `storage/`      | `LocalStorage` and `S3Storage` drivers.                                                                                                            |
| `pipeline/`     | Checkpointed generation state machine and the worker loop (claim, lease heartbeat, retries, cancel, recovery).                                     |
| `http/`         | Fastify app: auth, rate limits, validation, routes, video streaming with HTTP Range, static SPA.                                                   |
| `main.ts`       | Process entry: config, migrations, role selection, graceful shutdown.                                                                              |

### Web layout (`web/src`)

React 19 + Vite + TanStack Query + Tailwind CSS. Pages: Login, Create (script editor with pacing meter, character image drop zone, style/resolution/options, live cost estimate, optional split preview/edit), Generation detail (progress stepper, live status, 9:16 player, part 1 preview, download, regenerate, cost breakdown, prompts used, event log), History (grid with thumbnails, status, cost, filters, pagination).

## Generation pipeline

Each generation row is both the record and the job. Workers claim jobs with `SELECT ... FOR UPDATE SKIP LOCKED` and hold a lease (`locked_until`) renewed by a heartbeat. A crashed worker's lease expires and another worker resumes the job.

Every step is idempotent and checkpointed on the row, so a resumed job never pays twice for work already done:

| Stage              | Checkpoint                                                     | Skip when                                           |
| ------------------ | -------------------------------------------------------------- | --------------------------------------------------- |
| `planning`         | `plan`                                                         | plan present (auto split or user-reviewed)          |
| `uploading_image`  | `gemini_file_uri`, `gemini_file_expires_at`                    | file URI present and valid for at least 1 more hour |
| `generating_part1` | `part1_interaction_id`, `part1_status`, `part1_video_key`      | video stored                                        |
| `extending_part2`  | `part2_interaction_id`, `part2_status`, `part2_video_key`      | video stored                                        |
| `finalizing`       | `final_video_key`, `thumbnail_key`, `duration_sec`, `assembly` | final video stored                                  |

Interaction ids are persisted **before** waiting on the result. On resume, the worker polls the existing interaction instead of creating a new one.

Retry policy: transient failures (HTTP 429/500/503, timeouts, network) are retried with exponential backoff; each paid step is re-created at most `JOB_MAX_ATTEMPTS` times. Safety blocks, invalid arguments, auth errors and regional restrictions fail fast with a clear message.

## Costs

Estimated cost is computed before a job is accepted (and shown live in the UI):

- Part 1 video output: `10s × tokens_per_second(resolution) × video_output_price`
- Part 2 video output: `10s` (or `20s` when `EXTENSION_BILLING=full_output`) at the same rate
- Part 2 input context: previous video tokens × input price
- Character image input tokens, prompt text tokens, and one splitter call

Actual cost is recomputed from the `usage` block returned by each interaction and recorded in the `api_calls` ledger (kept even when a generation is deleted). `DAILY_BUDGET_USD` rejects new jobs when today's actual spend plus in-flight estimates would exceed the cap. All prices are configurable through `PRICE_*` / `VIDEO_TOKENS_PER_SEC_*` env vars.

## Security

- `GEMINI_API_KEY` is read only on the server, never sent to the browser, and redacted from logs and error messages.
- Web UI protected by `APP_PASSWORD` with an HMAC-signed, `HttpOnly`, `Secure`, `SameSite=Lax` session cookie; programmatic access via `API_TOKENS` bearer tokens.
- Mutating requests require a same-origin `Origin` header when present; strict security headers via helmet; per-IP rate limits; stricter limit on job creation.
- Uploaded images are sniffed by magic bytes, size-limited, re-encoded with ffmpeg (strips EXIF/GPS metadata).
- Storage keys are generated server-side (UUIDs); no user-controlled paths.
