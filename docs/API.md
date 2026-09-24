# HTTP API

All endpoints are under `/api` and exchange JSON unless noted. Types referenced below live in `server/src/shared/api.ts`.

Authentication: a session cookie (`omni_session`) set by `POST /api/auth/login`, or `Authorization: Bearer <token>` with one of `API_TOKENS`. Every endpoint except `/api/auth/*`, `/healthz` and `/readyz` requires authentication when auth is enabled; unauthenticated calls get `401`.

Errors always use `ApiErrorBody`: `{ "error": { "code": "string", "message": "string", "details"?: any } }`. `429` responses include a `Retry-After` header; `500` responses include `details.requestId` for log correlation.

| Code                     | HTTP | Meaning                                                                         |
| ------------------------ | ---- | ------------------------------------------------------------------------------- |
| `unauthorized`           | 401  | Missing/invalid session or token                                                |
| `forbidden_origin`       | 403  | Cross-origin mutating request                                                   |
| `not_found`              | 404  | Unknown generation or file                                                      |
| `validation_error`       | 400  | Invalid input (`details` = zod issues)                                          |
| `unsupported_media_type` | 415  | Image is not JPEG/PNG/WebP                                                      |
| `payload_too_large`      | 413  | Image larger than `LIMITS.imageMaxBytes`                                        |
| `budget_exceeded`        | 402  | `DAILY_BUDGET_USD` would be exceeded                                            |
| `queue_full`             | 429  | Too many queued/running jobs (`MAX_QUEUED_JOBS`)                                |
| `rate_limited`           | 429  | Too many requests                                                               |
| `conflict`               | 409  | Action not allowed in the current state                                         |
| `splitter_failed`        | 502  | Script split failed (only for `/api/plan`, generation falls back automatically) |
| `range_not_satisfiable`  | 416  | Byte range outside the file (media routes)                                      |
| `media_unavailable`      | 503  | Server-side image processing is unavailable (ffmpeg missing or timed out)       |
| `internal_error`         | 500  | Unexpected error                                                                |

## Auth

- `GET /api/auth/session` → `SessionResponse`
- `POST /api/auth/login` body `{ "password": string }` → `SessionResponse` and sets the cookie. `401 unauthorized` on a wrong password (constant-time compare, rate limited to 10/min/IP).
- `POST /api/auth/logout` → `204`, clears the cookie.

## App config

- `GET /api/config` → `AppConfigResponse` (models, pricing, defaults, limits, daily budget usage, mock flag).

## Planning and estimates

- `POST /api/plan` body `PlanRequest` → `ScriptPlan`. Runs the splitter (LLM, falling back to the deterministic splitter) and returns both parts with their final Omni prompts, so the user can review/edit before generating. Rate limited like creation.
- `POST /api/estimate` body `EstimateRequest` → `CostBreakdown`. `settings.reinforceCharacterOnExtend` adds the second image input; `hasPlan: true` leaves out the splitter call (a reviewed split will be sent); `mode: "part2"` prices only the extension.

## Generations

- `POST /api/generations` **multipart/form-data** with:
  - `payload`: JSON string of `CreateGenerationPayload` (`script`, `settings`, optional `plan`)
  - `characterImage`: the image file (JPEG/PNG/WebP, ≤ 10 MB)

  → `202` with `GenerationDTO` (status `queued`). A provided `plan` is validated and marked `source: "user"`; the prompts are rebuilt server-side from its fields so the prompt format stays consistent.

- `GET /api/generations?limit=20&cursor=...&status=succeeded` → `GenerationListResponse` (newest first, cursor pagination).
- `GET /api/generations/:id` → `GenerationDTO` (includes the latest 200 events). The UI polls this every 2s while the job is active. For failed or canceled jobs `failedStage` names the pipeline stage that was running when it stopped.
- `POST /api/generations/:id/regenerate` body `RegenerateRequest` → `202` `GenerationDTO` of the **new** generation (the character image is reused; `parentId` links to the source).
  - `mode: "full"`: new part 1 and part 2. Optional `script`, `settings`, `plan` edits.
  - `mode: "part2"`: reuses the source's part 1 interaction and video, re-runs only the extension. Requires the source to have a completed part 1 (`canRegeneratePart2`). Optional `part2` edits.
- `POST /api/generations/:id/cancel` → `GenerationDTO`. Queued jobs are canceled immediately; running jobs stop at the next checkpoint (the in-flight Google interaction is canceled best effort). `409 conflict` if already terminal.
- `DELETE /api/generations/:id` → `204`. Deletes stored files not shared with other generations. `409 conflict` while running (cancel first).

## Media

All media endpoints support `HEAD`, `Range` requests (`206 Partial Content`), `ETag`, and `Cache-Control: private`. With S3 and `S3_PRESIGNED_URLS=true` they respond `302` to a short-lived presigned URL instead.

- `GET /api/generations/:id/video` → final 20s MP4. `?download=1` adds `Content-Disposition: attachment; filename="<slug>-<id8>.mp4"`.
- `GET /api/generations/:id/part1` → part 1 MP4 (available as soon as part 1 finishes).
- `GET /api/generations/:id/thumbnail` → JPEG poster.
- `GET /api/generations/:id/character` → the normalized character image.

The DTO fields `videoUrl`, `downloadUrl`, `part1VideoUrl`, `thumbnailUrl`, `characterImageUrl` point at these endpoints (relative URLs), or are `null` when the file does not exist yet.

## Health

- `GET /healthz` → `200 {"status":"ok"}` (liveness, no dependencies).
- `GET /readyz` → `200` when the database (and storage) respond, else `503`.
