import type { Db } from './pool.js';
import type { ApiCallRecord, GenerationPatch, GenerationRecord, NewGeneration, UsageInfo } from '../core/ports.js';
import type {
  CostBreakdown,
  GenerationEvent,
  GenerationSettings,
  GenerationStage,
  GenerationStatus,
  ScriptPlan,
} from '../shared/api.js';

type Row = Record<string, unknown>;

/** camelCase record field -> snake_case column. `json` columns are (de)serialized as jsonb. */
const COLUMNS: Record<string, { column: string; json?: boolean }> = {
  status: { column: 'status' },
  stage: { column: 'stage' },
  progress: { column: 'progress' },
  stageStartedAt: { column: 'stage_started_at' },
  startedAt: { column: 'started_at' },
  completedAt: { column: 'completed_at' },
  title: { column: 'title' },
  script: { column: 'script' },
  settings: { column: 'settings', json: true },
  plan: { column: 'plan', json: true },
  characterImageKey: { column: 'character_image_key' },
  characterImageMime: { column: 'character_image_mime' },
  characterImageSha256: { column: 'character_image_sha256' },
  geminiFileUri: { column: 'gemini_file_uri' },
  geminiFileMime: { column: 'gemini_file_mime' },
  geminiFileExpiresAt: { column: 'gemini_file_expires_at' },
  part1InteractionId: { column: 'part1_interaction_id' },
  part1Status: { column: 'part1_status' },
  part1VideoKey: { column: 'part1_video_key' },
  part1Usage: { column: 'part1_usage', json: true },
  part1Attempts: { column: 'part1_attempts' },
  part2InteractionId: { column: 'part2_interaction_id' },
  part2Status: { column: 'part2_status' },
  part2VideoKey: { column: 'part2_video_key' },
  part2Usage: { column: 'part2_usage', json: true },
  part2Attempts: { column: 'part2_attempts' },
  finalVideoKey: { column: 'final_video_key' },
  thumbnailKey: { column: 'thumbnail_key' },
  durationSec: { column: 'duration_sec' },
  assembly: { column: 'assembly' },
  estimatedCost: { column: 'estimated_cost', json: true },
  estimatedCostUsd: { column: 'estimated_cost_usd' },
  actualCost: { column: 'actual_cost', json: true },
  actualCostUsd: { column: 'actual_cost_usd' },
  parentId: { column: 'parent_id' },
  regenerationMode: { column: 'regeneration_mode' },
  attempts: { column: 'attempts' },
  maxAttempts: { column: 'max_attempts' },
  runAfter: { column: 'run_after' },
  lockedBy: { column: 'locked_by' },
  lockedUntil: { column: 'locked_until' },
  cancelRequested: { column: 'cancel_requested' },
};

function toDate(v: unknown): Date | null {
  if (v === null || v === undefined) return null;
  return v instanceof Date ? v : new Date(String(v));
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export function mapGenerationRow(r: Row): GenerationRecord {
  const errorCode = r.error_code as string | null;
  return {
    id: r.id as string,
    createdAt: toDate(r.created_at)!,
    updatedAt: toDate(r.updated_at)!,
    createdBy: (r.created_by as string | null) ?? null,
    status: r.status as GenerationStatus,
    stage: r.stage as GenerationStage,
    progress: toNum(r.progress) ?? 0,
    stageStartedAt: toDate(r.stage_started_at),
    startedAt: toDate(r.started_at),
    completedAt: toDate(r.completed_at),
    title: r.title as string,
    script: r.script as string,
    settings: r.settings as GenerationSettings,
    plan: (r.plan as ScriptPlan | null) ?? null,
    characterImageKey: r.character_image_key as string,
    characterImageMime: r.character_image_mime as string,
    characterImageSha256: r.character_image_sha256 as string,
    geminiFileUri: (r.gemini_file_uri as string | null) ?? null,
    geminiFileMime: (r.gemini_file_mime as string | null) ?? null,
    geminiFileExpiresAt: toDate(r.gemini_file_expires_at),
    part1InteractionId: (r.part1_interaction_id as string | null) ?? null,
    part1Status: (r.part1_status as string | null) ?? null,
    part1VideoKey: (r.part1_video_key as string | null) ?? null,
    part1Usage: (r.part1_usage as UsageInfo | null) ?? null,
    part1Attempts: toNum(r.part1_attempts) ?? 0,
    part2InteractionId: (r.part2_interaction_id as string | null) ?? null,
    part2Status: (r.part2_status as string | null) ?? null,
    part2VideoKey: (r.part2_video_key as string | null) ?? null,
    part2Usage: (r.part2_usage as UsageInfo | null) ?? null,
    part2Attempts: toNum(r.part2_attempts) ?? 0,
    finalVideoKey: (r.final_video_key as string | null) ?? null,
    thumbnailKey: (r.thumbnail_key as string | null) ?? null,
    durationSec: toNum(r.duration_sec),
    assembly: (r.assembly as GenerationRecord['assembly']) ?? null,
    estimatedCost: r.estimated_cost as CostBreakdown,
    estimatedCostUsd: toNum(r.estimated_cost_usd) ?? 0,
    actualCost: (r.actual_cost as CostBreakdown | null) ?? null,
    actualCostUsd: toNum(r.actual_cost_usd),
    error: errorCode
      ? {
          code: errorCode,
          message: (r.error_message as string | null) ?? 'Unknown error',
          retryable: Boolean(r.error_retryable),
        }
      : null,
    parentId: (r.parent_id as string | null) ?? null,
    regenerationMode: (r.regeneration_mode as GenerationRecord['regenerationMode']) ?? null,
    attempts: toNum(r.attempts) ?? 0,
    maxAttempts: toNum(r.max_attempts) ?? 3,
    runAfter: toDate(r.run_after)!,
    lockedBy: (r.locked_by as string | null) ?? null,
    lockedUntil: toDate(r.locked_until),
    cancelRequested: Boolean(r.cancel_requested),
  };
}

function buildSet(patch: GenerationPatch, startIndex: number): { sql: string[]; values: unknown[] } {
  const sql: string[] = [];
  const values: unknown[] = [];
  let i = startIndex;
  for (const [field, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (field === 'error') {
      const err = value as GenerationPatch['error'];
      sql.push(`error_code = $${i++}`, `error_message = $${i++}`, `error_retryable = $${i++}`);
      values.push(err?.code ?? null, err?.message ?? null, err ? err.retryable : null);
      continue;
    }
    const col = COLUMNS[field];
    if (!col) throw new Error(`Unknown generation field: ${field}`);
    sql.push(`${col.column} = $${i++}`);
    values.push(col.json && value !== null ? JSON.stringify(value) : value);
  }
  sql.push('updated_at = now()');
  return { sql, values };
}

export interface ListOptions {
  limit: number;
  cursor?: string | null;
  status?: GenerationStatus | null;
}

export interface SpendSummary {
  /** Actual (or best-known) spend recorded in the ledger since `since`. */
  spentUsd: number;
  /** Estimated cost still to be incurred by queued/running jobs. */
  reservedUsd: number;
}

export class GenerationRepository {
  constructor(private readonly db: Db) {}

  async insert(g: NewGeneration): Promise<GenerationRecord> {
    const { rows } = await this.db.query(
      `INSERT INTO generations (
         id, created_by, status, stage, progress, title, script, settings, plan,
         character_image_key, character_image_mime, character_image_sha256,
         gemini_file_uri, gemini_file_mime, gemini_file_expires_at,
         part1_interaction_id, part1_status, part1_video_key, part1_usage,
         estimated_cost, estimated_cost_usd, parent_id, regeneration_mode, max_attempts
       ) VALUES (
         $1, $2, 'queued', 'queued', 0, $3, $4, $5, $6,
         $7, $8, $9,
         $10, $11, $12,
         $13, $14, $15, $16,
         $17, $18, $19, $20, $21
       ) RETURNING *`,
      [
        g.id,
        g.createdBy,
        g.title,
        g.script,
        JSON.stringify(g.settings),
        g.plan ? JSON.stringify(g.plan) : null,
        g.characterImageKey,
        g.characterImageMime,
        g.characterImageSha256,
        g.geminiFileUri ?? null,
        g.geminiFileMime ?? null,
        g.geminiFileExpiresAt ?? null,
        g.part1InteractionId ?? null,
        g.part1Status ?? null,
        g.part1VideoKey ?? null,
        g.part1Usage ? JSON.stringify(g.part1Usage) : null,
        JSON.stringify(g.estimatedCost),
        g.estimatedCost.totalUsd,
        g.parentId,
        g.regenerationMode,
        g.maxAttempts,
      ],
    );
    return mapGenerationRow(rows[0] as Row);
  }

  async get(id: string): Promise<GenerationRecord | null> {
    const { rows } = await this.db.query('SELECT * FROM generations WHERE id = $1', [id]);
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  async list(opts: ListOptions): Promise<{ items: GenerationRecord[]; nextCursor: string | null }> {
    const limit = Math.min(Math.max(opts.limit, 1), 100);
    const where: string[] = [];
    const values: unknown[] = [];
    if (opts.status) {
      values.push(opts.status);
      where.push(`status = $${values.length}`);
    }
    const cursor = decodeCursor(opts.cursor);
    if (cursor) {
      values.push(cursor.createdAt, cursor.id);
      where.push(`(created_at, id) < ($${values.length - 1}, $${values.length})`);
    }
    values.push(limit + 1);
    const { rows } = await this.db.query(
      `SELECT * FROM generations ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC, id DESC LIMIT $${values.length}`,
      values,
    );
    const items = rows.slice(0, limit).map((r) => mapGenerationRow(r as Row));
    const last = items[items.length - 1];
    const nextCursor = rows.length > limit && last ? encodeCursor(last.createdAt, last.id) : null;
    return { items, nextCursor };
  }

  /**
   * Applies a patch. When `lockedBy` is given the update only succeeds while that worker still
   * holds the lease (fencing against a worker whose lease expired). Returns null when fenced out
   * or when the row no longer exists.
   */
  async update(id: string, patch: GenerationPatch, opts: { lockedBy?: string } = {}): Promise<GenerationRecord | null> {
    const { sql, values } = buildSet(patch, 2);
    const params: unknown[] = [id, ...values];
    let where = 'id = $1';
    if (opts.lockedBy) {
      params.push(opts.lockedBy);
      where += ` AND locked_by = $${params.length}`;
    }
    const { rows } = await this.db.query(`UPDATE generations SET ${sql.join(', ')} WHERE ${where} RETURNING *`, params);
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  /**
   * Claims the oldest runnable job: queued jobs whose run_after has passed, or running jobs whose
   * lease expired (crashed worker). Increments `attempts` only for fresh claims of queued jobs so
   * resumptions after a crash do not burn retry budget.
   */
  async claimNext(workerId: string, leaseMs: number): Promise<GenerationRecord | null> {
    const { rows } = await this.db.query(
      `UPDATE generations g
          SET status = 'running',
              locked_by = $1,
              locked_until = now() + ($2 || ' milliseconds')::interval,
              attempts = CASE WHEN g.status = 'queued' THEN g.attempts + 1 ELSE g.attempts END,
              started_at = COALESCE(g.started_at, now()),
              updated_at = now()
        WHERE g.id = (
          SELECT id FROM generations
           WHERE (status = 'queued' AND run_after <= now())
              OR (status = 'running' AND (locked_until IS NULL OR locked_until < now()))
           ORDER BY run_after, created_at
           FOR UPDATE SKIP LOCKED
           LIMIT 1)
      RETURNING *`,
      [workerId, String(Math.round(leaseMs))],
    );
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  /** Extends the lease. Returns the fresh record, or null if the lease was lost. */
  async heartbeat(id: string, workerId: string, leaseMs: number): Promise<GenerationRecord | null> {
    const { rows } = await this.db.query(
      `UPDATE generations
          SET locked_until = now() + ($3 || ' milliseconds')::interval
        WHERE id = $1 AND locked_by = $2 AND status = 'running'
      RETURNING *`,
      [id, workerId, String(Math.round(leaseMs))],
    );
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  /** Releases the lease without finishing (graceful shutdown): the job becomes immediately claimable. */
  async releaseLease(id: string, workerId: string): Promise<void> {
    await this.db.query(
      `UPDATE generations SET locked_until = now(), updated_at = now()
        WHERE id = $1 AND locked_by = $2 AND status = 'running'`,
      [id, workerId],
    );
  }

  /** Puts a job back in the queue for a retry after `delayMs`. */
  async requeue(
    id: string,
    workerId: string,
    delayMs: number,
    patch: GenerationPatch = {},
  ): Promise<GenerationRecord | null> {
    const { sql, values } = buildSet(patch, 4);
    const { rows } = await this.db.query(
      `UPDATE generations
          SET status = 'queued', locked_by = NULL, locked_until = NULL,
              run_after = now() + ($3 || ' milliseconds')::interval, ${sql.join(', ')}
        WHERE id = $1 AND locked_by = $2
      RETURNING *`,
      [id, workerId, String(Math.round(delayMs)), ...values],
    );
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  /**
   * Marks cancel requested. Queued jobs are canceled immediately; running jobs are canceled by
   * their worker at the next checkpoint. Returns the updated record or null if not found.
   */
  async requestCancel(id: string): Promise<GenerationRecord | null> {
    const { rows } = await this.db.query(
      `UPDATE generations
          SET cancel_requested = true,
              status = CASE WHEN status = 'queued' THEN 'canceled' ELSE status END,
              stage = CASE WHEN status = 'queued' THEN 'canceled' ELSE stage END,
              completed_at = CASE WHEN status = 'queued' THEN now() ELSE completed_at END,
              locked_by = CASE WHEN status = 'queued' THEN NULL ELSE locked_by END,
              updated_at = now()
        WHERE id = $1
      RETURNING *`,
      [id],
    );
    return rows[0] ? mapGenerationRow(rows[0] as Row) : null;
  }

  async delete(id: string): Promise<boolean> {
    const res = await this.db.query('DELETE FROM generations WHERE id = $1', [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /** Storage keys still referenced by other generations (part 1 videos can be shared by part-2 regenerations). */
  async isKeyReferencedElsewhere(key: string, excludeId: string): Promise<boolean> {
    const { rows } = await this.db.query(
      `SELECT 1 FROM generations
        WHERE id <> $2 AND (character_image_key = $1 OR part1_video_key = $1 OR part2_video_key = $1
                            OR final_video_key = $1 OR thumbnail_key = $1)
        LIMIT 1`,
      [key, excludeId],
    );
    return rows.length > 0;
  }

  async addEvent(
    generationId: string,
    stage: GenerationStage,
    level: GenerationEvent['level'],
    message: string,
    data?: unknown,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO generation_events (generation_id, stage, level, message, data) VALUES ($1, $2, $3, $4, $5)`,
      [generationId, stage, level, message, data === undefined ? null : JSON.stringify(data)],
    );
  }

  async listEvents(generationId: string, limit = 200): Promise<GenerationEvent[]> {
    const { rows } = await this.db.query(
      `SELECT at, stage, level, message FROM (
         SELECT * FROM generation_events WHERE generation_id = $1 ORDER BY id DESC LIMIT $2
       ) e ORDER BY id ASC`,
      [generationId, limit],
    );
    return rows.map((r) => ({
      at: toDate(r.at)!.toISOString(),
      stage: r.stage as GenerationStage,
      level: r.level as GenerationEvent['level'],
      message: r.message as string,
    }));
  }

  /** Inserts or updates (by interaction id) a ledger entry. Returns the ledger row id. */
  async recordApiCall(call: ApiCallRecord): Promise<number> {
    if (call.interactionId) {
      const { rows } = await this.db.query(
        `INSERT INTO api_calls (generation_id, kind, model, interaction_id, status, usage, cost_usd, cost_basis, completed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, CASE WHEN $5 IN ('completed','failed','cancelled','incomplete') THEN now() END)
         ON CONFLICT (interaction_id) WHERE interaction_id IS NOT NULL DO UPDATE
           SET status = EXCLUDED.status, usage = COALESCE(EXCLUDED.usage, api_calls.usage),
               cost_usd = EXCLUDED.cost_usd, cost_basis = EXCLUDED.cost_basis,
               completed_at = COALESCE(EXCLUDED.completed_at, api_calls.completed_at)
         RETURNING id`,
        [
          call.generationId,
          call.kind,
          call.model,
          call.interactionId,
          call.status,
          call.usage ? JSON.stringify(call.usage) : null,
          call.costUsd,
          call.costBasis,
        ],
      );
      return Number(rows[0]!.id);
    }
    const { rows } = await this.db.query(
      `INSERT INTO api_calls (generation_id, kind, model, interaction_id, status, usage, cost_usd, cost_basis, completed_at)
       VALUES ($1, $2, $3, NULL, $4, $5, $6, $7, now()) RETURNING id`,
      [
        call.generationId,
        call.kind,
        call.model,
        call.status,
        call.usage ? JSON.stringify(call.usage) : null,
        call.costUsd,
        call.costBasis,
      ],
    );
    return Number(rows[0]!.id);
  }

  /** Sum of ledger costs for one generation, by call kind. */
  async ledgerCostsForGeneration(generationId: string): Promise<Record<ApiCallRecord['kind'], number>> {
    const { rows } = await this.db.query(
      `SELECT kind, COALESCE(SUM(cost_usd), 0) AS cost FROM api_calls WHERE generation_id = $1 GROUP BY kind`,
      [generationId],
    );
    const out: Record<ApiCallRecord['kind'], number> = { split: 0, part1: 0, part2: 0, upload: 0 };
    for (const r of rows as Row[]) out[r.kind as ApiCallRecord['kind']] = toNum(r.cost) ?? 0;
    return out;
  }

  async spendSince(since: Date): Promise<SpendSummary> {
    const { rows } = await this.db.query(
      `SELECT
         (SELECT COALESCE(SUM(cost_usd), 0) FROM api_calls WHERE created_at >= $1) AS spent,
         (SELECT COALESCE(SUM(GREATEST(g.estimated_cost_usd - COALESCE(
             (SELECT SUM(a.cost_usd) FROM api_calls a WHERE a.generation_id = g.id), 0), 0)), 0)
            FROM generations g WHERE g.status IN ('queued','running')) AS reserved`,
      [since],
    );
    const r = rows[0] as Row;
    return { spentUsd: toNum(r.spent) ?? 0, reservedUsd: toNum(r.reserved) ?? 0 };
  }

  async countActive(): Promise<number> {
    const { rows } = await this.db.query(
      `SELECT COUNT(*)::int AS n FROM generations WHERE status IN ('queued','running')`,
    );
    return Number((rows[0] as Row).n);
  }

  async getAppState<T>(key: string): Promise<T | null> {
    const { rows } = await this.db.query('SELECT value FROM app_state WHERE key = $1', [key]);
    return rows[0] ? ((rows[0] as Row).value as T) : null;
  }

  async setAppState(key: string, value: unknown): Promise<void> {
    await this.db.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ($1, $2, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [key, JSON.stringify(value)],
    );
  }

  async ping(): Promise<void> {
    await this.db.query('SELECT 1');
  }
}

function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify([createdAt.toISOString(), id])).toString('base64url');
}

function decodeCursor(cursor: string | null | undefined): { createdAt: Date; id: string } | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    if (!Array.isArray(parsed) || parsed.length !== 2) return null;
    const [iso, id] = parsed as [unknown, unknown];
    if (typeof iso !== 'string' || typeof id !== 'string') return null;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}
