/**
 * Ordered SQL migrations. Embedded as strings so the compiled server needs no extra assets.
 * Never edit an applied migration: append a new one instead.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init',
    sql: `
CREATE TABLE IF NOT EXISTS generations (
  id                      uuid PRIMARY KEY,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now(),
  created_by              text,

  status                  text NOT NULL CHECK (status IN ('queued','running','succeeded','failed','canceled')),
  stage                   text NOT NULL,
  progress                real NOT NULL DEFAULT 0,
  stage_started_at        timestamptz,
  started_at              timestamptz,
  completed_at            timestamptz,

  title                   text NOT NULL,
  script                  text NOT NULL,
  settings                jsonb NOT NULL,
  plan                    jsonb,

  character_image_key     text NOT NULL,
  character_image_mime    text NOT NULL,
  character_image_sha256  text NOT NULL,
  gemini_file_uri         text,
  gemini_file_mime        text,
  gemini_file_expires_at  timestamptz,

  part1_interaction_id    text,
  part1_status            text,
  part1_video_key         text,
  part1_usage             jsonb,
  part1_attempts          integer NOT NULL DEFAULT 0,

  part2_interaction_id    text,
  part2_status            text,
  part2_video_key         text,
  part2_usage             jsonb,
  part2_attempts          integer NOT NULL DEFAULT 0,

  final_video_key         text,
  thumbnail_key           text,
  duration_sec            real,
  assembly                text CHECK (assembly IS NULL OR assembly IN ('model_full','concatenated')),

  estimated_cost          jsonb NOT NULL,
  estimated_cost_usd      numeric(12,4) NOT NULL DEFAULT 0,
  actual_cost             jsonb,
  actual_cost_usd         numeric(12,4),

  error_code              text,
  error_message           text,
  error_retryable         boolean,

  parent_id               uuid REFERENCES generations(id) ON DELETE SET NULL,
  regeneration_mode       text CHECK (regeneration_mode IS NULL OR regeneration_mode IN ('full','part2')),

  attempts                integer NOT NULL DEFAULT 0,
  max_attempts            integer NOT NULL DEFAULT 3,
  run_after               timestamptz NOT NULL DEFAULT now(),
  locked_by               text,
  locked_until            timestamptz,
  cancel_requested        boolean NOT NULL DEFAULT false
);

CREATE INDEX IF NOT EXISTS generations_created_at_idx ON generations (created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS generations_claim_idx ON generations (run_after) WHERE status IN ('queued','running');
CREATE INDEX IF NOT EXISTS generations_parent_idx ON generations (parent_id);

CREATE TABLE IF NOT EXISTS generation_events (
  id             bigserial PRIMARY KEY,
  generation_id  uuid NOT NULL REFERENCES generations(id) ON DELETE CASCADE,
  at             timestamptz NOT NULL DEFAULT now(),
  stage          text NOT NULL,
  level          text NOT NULL CHECK (level IN ('info','warn','error')),
  message        text NOT NULL,
  data           jsonb
);
CREATE INDEX IF NOT EXISTS generation_events_gen_idx ON generation_events (generation_id, id);

-- Ledger of every billable call to Google. Kept even when a generation is deleted so spend stays auditable.
CREATE TABLE IF NOT EXISTS api_calls (
  id              bigserial PRIMARY KEY,
  generation_id   uuid,
  kind            text NOT NULL CHECK (kind IN ('split','part1','part2','upload')),
  model           text NOT NULL,
  interaction_id  text,
  status          text NOT NULL,
  usage           jsonb,
  cost_usd        numeric(12,6) NOT NULL DEFAULT 0,
  cost_basis      text NOT NULL DEFAULT 'estimate' CHECK (cost_basis IN ('estimate','actual')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  completed_at    timestamptz
);
CREATE INDEX IF NOT EXISTS api_calls_created_idx ON api_calls (created_at);
CREATE INDEX IF NOT EXISTS api_calls_generation_idx ON api_calls (generation_id);
CREATE UNIQUE INDEX IF NOT EXISTS api_calls_interaction_uidx ON api_calls (interaction_id) WHERE interaction_id IS NOT NULL;
`,
  },
  {
    id: '002_app_state',
    sql: `
-- Small key/value store for process-wide facts learned at runtime (e.g. the Gemini transport that works).
CREATE TABLE IF NOT EXISTS app_state (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);
`,
  },
  {
    id: '003_captions',
    sql: `
ALTER TABLE generations ADD COLUMN IF NOT EXISTS final_clean_key text;
ALTER TABLE generations ADD COLUMN IF NOT EXISTS caption_engine text;
`,
  },
];
