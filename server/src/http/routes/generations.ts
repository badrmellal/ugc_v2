import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppContext } from '../../app-context.js';
import type { GenerationRecord, NewGeneration } from '../../core/ports.js';
import { estimateCost } from '../../pricing/pricing.js';
import {
  isTerminalStatus,
  type GenerationDTO,
  type GenerationListResponse,
  type GenerationSettings,
  type GenerationStatus,
  type ScriptPlan,
} from '../../shared/api.js';
import { generationKeys } from '../../storage/index.js';
import { withAdmissionLock } from '../admission.js';
import { assertQueueCapacity, assertWithinBudget } from '../budget.js';
import { PART1_REUSE_MAX_AGE_MS, toGenerationDTO, toListItem } from '../dto.js';
import { conflict, HttpError, notFound, validationError } from '../errors.js';
import { createGenerationPayloadSchema, isUuid, listQuerySchema, regenerateRequestSchema } from '../schemas.js';
import { parsePayloadField, readGenerationUpload, sha256File, sniffImage } from '../upload.js';
import type { RouteDeps } from './types.js';

/** Longest side of the stored character image. */
export const CHARACTER_MAX_SIDE = 2048;
const TITLE_MAX = 80;

type IdParams = { Params: { id: string } };

/** First sentence of the script, on one line, at most 80 characters. */
export function deriveTitle(script: string): string {
  const oneLine = script.replace(/\s+/g, ' ').trim();
  const firstLine = script.trim().split(/\r?\n/, 1)[0]?.trim() ?? oneLine;
  // Latin sentence ends need a following space ("3.5" is not an end); CJK full stops do not.
  const sentence = (/^.*?(?:[.!?](?=\s|$)|[。！？])/u.exec(firstLine)?.[0] ?? firstLine).replace(/\s+/g, ' ').trim();
  const title = sentence || oneLine || 'Untitled video';
  if (title.length <= TITLE_MAX) return title;
  const cut = title.slice(0, TITLE_MAX - 3);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > 40 ? cut.slice(0, lastSpace) : cut).replace(/[\s,;:.-]+$/u, '')}...`;
}

/** Settings that change what is said or shown, and therefore require a new script split. */
const SPLIT_AFFECTING: (keyof GenerationSettings)[] = ['style', 'theme', 'language', 'voiceHint', 'extraDirections'];

function changedSettings(a: GenerationSettings, b: GenerationSettings): (keyof GenerationSettings)[] {
  return (Object.keys(a) as (keyof GenerationSettings)[]).filter((k) => a[k] !== b[k]);
}

function alreadyDone(status: GenerationStatus): string {
  const done = status === 'succeeded' ? 'finished' : status === 'failed' ? 'failed' : 'been canceled';
  return `This generation has already ${done}.`;
}

function createdByOf(req: FastifyRequest): string | null {
  const auth = req.auth;
  if (!auth || auth.method === 'none') return null;
  return auth.subject;
}

export function registerGenerationRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;
  const { config, repo } = ctx;

  const loadGeneration = async (id: string): Promise<GenerationRecord> => {
    if (!isUuid(id)) throw notFound();
    const g = await repo.get(id);
    if (!g) throw notFound();
    return g;
  };

  /** Validates a plan and rebuilds its prompts server-side (400 when the planner rejects it). */
  const finalizePlan = (plan: ScriptPlan, settings: GenerationSettings): ScriptPlan => {
    try {
      return ctx.planner.finalize(plan, settings);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'the plan is invalid';
      throw validationError(`The edited script split is invalid: ${message}`);
    }
  };
  const finalizeUserPlan = (plan: ScriptPlan, settings: GenerationSettings) =>
    finalizePlan({ ...plan, source: 'user' }, settings);

  /**
   * Inserts a job after re-checking the queue and the budget under the admission lock, so parallel
   * requests (on any instance) cannot all pass the checks. A regeneration also re-checks that its
   * source still exists: a concurrent delete may have just removed the files it would reuse.
   */
  const admit = (g: NewGeneration): Promise<GenerationRecord> =>
    withAdmissionLock(ctx.db, async (tx) => {
      if (g.parentId && !(await tx.get(g.parentId))) {
        throw notFound('The source generation was deleted.');
      }
      await assertQueueCapacity(tx, config.worker.maxQueuedJobs);
      await assertWithinBudget(tx, config.budget.dailyUsd, g.estimatedCost.totalUsd);
      return tx.insert(g);
    });

  const dtoFor = async (g: GenerationRecord): Promise<GenerationDTO> => {
    const events = await repo.listEvents(g.id, 200);
    const part1CreatedAt = await resolvePart1CreatedAt(ctx, g);
    return toGenerationDTO(g, events, Date.now(), { turnSeconds: deps.turnSeconds, part1CreatedAt });
  };

  const enqueued = async (req: FastifyRequest, reply: FastifyReply, g: GenerationRecord, message: string) => {
    await repo
      .addEvent(g.id, 'queued', 'info', message)
      .catch((err: unknown) => req.log.warn({ err }, 'failed to write the queued event'));
    ctx.worker?.notify();
    req.log.info(
      { generationId: g.id, parentId: g.parentId, mode: g.regenerationMode ?? 'new', estimateUsd: g.estimatedCostUsd },
      'generation queued',
    );
    return reply.code(202).send(await dtoFor(g));
  };

  // ---------------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------------

  app.post('/api/generations', { onRequest: deps.createLimit }, async (req, reply) => {
    if (!req.isMultipart()) {
      throw new HttpError(
        415,
        'unsupported_media_type',
        'Send the generation as multipart/form-data with a "payload" JSON field and a "characterImage" file.',
      );
    }
    // Cheap check first, before receiving up to 10 MB of image (re-checked atomically on insert).
    await assertQueueCapacity(repo, config.worker.maxQueuedJobs);
    const dir = await mkdtemp(join(tmpdir(), 'omni-upload-'));
    try {
      const upload = await readGenerationUpload(req, dir);
      const payload = createGenerationPayloadSchema.parse(parsePayloadField(upload.payload));
      const plan = payload.plan ? finalizeUserPlan(payload.plan, payload.settings) : null;
      if (!upload.image) throw validationError('Attach the character image as the "characterImage" file.');
      await sniffImage(upload.image.path, upload.image.size);

      const estimatedCost = estimateCost(config.pricing, {
        resolution: payload.settings.resolution,
        mode: 'full',
        needsSplit: !plan,
        reinforceCharacterOnExtend: payload.settings.reinforceCharacterOnExtend,
      });
      // Before the costly re-encode (re-checked atomically on insert).
      await assertWithinBudget(repo, config.budget.dailyUsd, estimatedCost.totalUsd);

      // Re-encode to JPEG: auto-orients, strips EXIF/GPS metadata and caps the resolution.
      const normalized = join(dir, 'character.jpg');
      try {
        await ctx.media.normalizeImage(upload.image.path, normalized, CHARACTER_MAX_SIDE);
      } catch (err) {
        const code = (err as { code?: unknown }).code;
        if (code === 'binary_not_found' || code === 'spawn_failed' || code === 'timeout' || code === 'no_output') {
          // Server-side media processing fault, not a problem with the upload.
          req.log.error({ err }, 'image processing failed');
          throw new HttpError(
            503,
            'media_unavailable',
            'Image processing is temporarily unavailable. Try again shortly.',
          );
        }
        req.log.info({ err }, 'character image could not be decoded');
        if (code === 'image_too_large') {
          throw new HttpError(
            413,
            'payload_too_large',
            'The character image has too many pixels. Resize it (for example to 2048 pixels on the longest side) and try again.',
          );
        }
        throw new HttpError(
          415,
          'unsupported_media_type',
          'The character image could not be read. Upload a valid JPEG, PNG or WebP image.',
        );
      }
      const sha256 = await sha256File(normalized);

      const id = randomUUID();
      const keys = generationKeys(id);
      await ctx.storage.putFile(keys.characterImage, normalized, 'image/jpeg');
      let record: GenerationRecord;
      try {
        record = await admit({
          id,
          createdBy: createdByOf(req),
          title: deriveTitle(payload.script),
          script: payload.script,
          settings: payload.settings,
          plan,
          characterImageKey: keys.characterImage,
          characterImageMime: 'image/jpeg',
          characterImageSha256: sha256,
          estimatedCost,
          parentId: null,
          regenerationMode: null,
          maxAttempts: config.worker.maxAttempts,
        });
      } catch (err) {
        await ctx.storage.delete(keys.characterImage).catch(() => undefined);
        throw err;
      }
      return await enqueued(req, reply, record, 'Queued');
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  });

  // ---------------------------------------------------------------------------
  // Read
  // ---------------------------------------------------------------------------

  app.get('/api/generations', async (req): Promise<GenerationListResponse> => {
    const query = listQuerySchema.parse(req.query);
    const page = await repo.list({ limit: query.limit, cursor: query.cursor ?? null, status: query.status ?? null });
    return { items: page.items.map(toListItem), nextCursor: page.nextCursor };
  });

  app.get<IdParams>('/api/generations/:id', async (req): Promise<GenerationDTO> => {
    return dtoFor(await loadGeneration(req.params.id));
  });

  // ---------------------------------------------------------------------------
  // Regenerate
  // ---------------------------------------------------------------------------

  app.post<IdParams>('/api/generations/:id/regenerate', { onRequest: deps.createLimit }, async (req, reply) => {
    const source = await loadGeneration(req.params.id);
    const body = regenerateRequestSchema.parse(req.body ?? {});
    const shared = {
      createdBy: createdByOf(req),
      title: source.title,
      characterImageKey: source.characterImageKey,
      characterImageMime: source.characterImageMime,
      characterImageSha256: source.characterImageSha256,
      geminiFileUri: source.geminiFileUri,
      geminiFileMime: source.geminiFileMime,
      geminiFileExpiresAt: source.geminiFileExpiresAt,
      parentId: source.id,
      maxAttempts: config.worker.maxAttempts,
    } satisfies Partial<NewGeneration>;

    if (body.mode === 'full') {
      const script = body.script ?? source.script;
      const settings: GenerationSettings = { ...source.settings };
      for (const [key, value] of Object.entries(body.settings ?? {})) {
        if (value !== undefined) (settings as unknown as Record<string, unknown>)[key] = value;
      }
      const changed = changedSettings(settings, source.settings);
      const needsResplit = script !== source.script || changed.some((k) => SPLIT_AFFECTING.includes(k));

      let plan: ScriptPlan | null;
      if (body.plan) plan = finalizeUserPlan(body.plan, settings);
      else if (body.plan === null || needsResplit || !source.plan) plan = null;
      // Only render settings changed (resolution, image mode...): keep the split, rebuild the prompts.
      else if (changed.length) plan = finalizePlan(source.plan, settings);
      else plan = source.plan;

      const estimatedCost = estimateCost(config.pricing, {
        resolution: settings.resolution,
        mode: 'full',
        needsSplit: !plan,
        reinforceCharacterOnExtend: settings.reinforceCharacterOnExtend,
      });

      const record = await admit({
        ...shared,
        id: randomUUID(),
        title: script === source.script ? source.title : deriveTitle(script),
        script,
        settings,
        plan,
        estimatedCost,
        regenerationMode: 'full',
      });
      return enqueued(req, reply, record, `Queued: full regeneration of ${source.id.slice(0, 8)}`);
    }

    // mode === 'part2': keep part 1 (same interaction chain) and only re-run the 10s extension.
    if (!source.part1VideoKey || !source.part1InteractionId || !source.plan) {
      throw conflict('Part 2 can only be regenerated after part 1 (0-10s) of this video has been generated.');
    }
    if (!isTerminalStatus(source.status)) {
      throw conflict('Wait for this generation to finish, or cancel it, before regenerating part 2.');
    }
    const part1CreatedAt = await resolvePart1CreatedAt(ctx, source);
    if (Date.now() - part1CreatedAt.getTime() >= PART1_REUSE_MAX_AGE_MS) {
      throw conflict(
        'Part 1 of this video is too old to extend again: Gemini keeps interactions for 55 days. Use a full regeneration instead.',
      );
    }

    let plan: ScriptPlan = source.plan;
    const edits = Object.fromEntries(Object.entries(body.part2 ?? {}).filter(([, v]) => v !== undefined));
    if (Object.keys(edits).length) {
      const [first, second] = source.plan.segments;
      plan = finalizeUserPlan({ ...source.plan, segments: [first, { ...second, ...edits }] }, source.settings);
    }

    const estimatedCost = estimateCost(config.pricing, {
      resolution: source.settings.resolution,
      mode: 'part2',
      needsSplit: false,
      reinforceCharacterOnExtend: source.settings.reinforceCharacterOnExtend,
    });

    const record = await admit({
      ...shared,
      id: randomUUID(),
      script: source.script,
      settings: source.settings,
      plan,
      part1InteractionId: source.part1InteractionId,
      part1Status: 'completed',
      part1VideoKey: source.part1VideoKey,
      part1Usage: source.part1Usage,
      estimatedCost,
      regenerationMode: 'part2',
    });
    return enqueued(req, reply, record, `Queued: new extension (10-20s) for part 1 of ${source.id.slice(0, 8)}`);
  });

  // ---------------------------------------------------------------------------
  // Cancel / delete
  // ---------------------------------------------------------------------------

  app.post<IdParams>('/api/generations/:id/cancel', async (req): Promise<GenerationDTO> => {
    const current = await loadGeneration(req.params.id);
    if (isTerminalStatus(current.status)) throw conflict(alreadyDone(current.status));
    const updated = await repo.requestCancel(current.id);
    if (!updated) throw notFound();
    if (updated.status === 'succeeded' || updated.status === 'failed') {
      // It finished between the read above and the cancel request.
      throw conflict(alreadyDone(updated.status));
    }
    if (updated.status === 'canceled') {
      if (current.status === 'queued') {
        await repo.addEvent(updated.id, 'canceled', 'info', 'Canceled while waiting in the queue');
      }
    } else if (!current.cancelRequested) {
      await repo.addEvent(updated.id, updated.stage, 'info', 'Cancel requested, stopping at the next checkpoint');
    }
    req.log.info({ generationId: updated.id, status: updated.status }, 'cancel requested');
    return dtoFor(updated);
  });

  app.delete<IdParams>('/api/generations/:id', async (req, reply) => {
    const { id } = req.params;
    if (!isUuid(id)) throw notFound();
    // Files can be shared (the character image with regenerations, part 1 with part-2 regenerations).
    // Deciding what is unshared and deleting the row happen under the admission lock, so no regeneration
    // can start to reference a file between the check and the delete; files are removed after commit.
    const { g, keys, unshared } = await withAdmissionLock(ctx.db, async (tx) => {
      const found = await tx.get(id);
      if (!found) throw notFound();
      if (found.status === 'queued' || found.status === 'running') {
        throw conflict('This generation is still in progress. Cancel it first, then delete it.');
      }
      const ownKeys = [
        ...new Set(
          [
            found.characterImageKey,
            found.part1VideoKey,
            found.part2VideoKey,
            found.finalVideoKey,
            found.thumbnailKey,
          ].filter((k): k is string => Boolean(k)),
        ),
      ];
      const notShared: string[] = [];
      for (const key of ownKeys) {
        if (!(await tx.isKeyReferencedElsewhere(key, found.id))) notShared.push(key);
      }
      if (!(await tx.delete(found.id))) throw notFound();
      return { g: found, keys: ownKeys, unshared: notShared };
    });

    const ownPrefix = generationKeys(g.id).prefix;
    const sharedOwnFiles = keys.some((k) => k.startsWith(ownPrefix) && !unshared.includes(k));
    const results = await Promise.allSettled([
      ...unshared.map((key) => ctx.storage.delete(key)),
      // Also sweep leftovers (partial uploads) unless another generation still uses a file in it.
      ...(sharedOwnFiles ? [] : [ctx.storage.deletePrefix(ownPrefix)]),
    ]);
    const failures = results.filter((r) => r.status === 'rejected').length;
    if (failures) req.log.warn({ generationId: g.id, failures }, 'some stored files could not be deleted');
    req.log.info({ generationId: g.id, deletedFiles: unshared.length }, 'generation deleted');
    return reply.code(204).send();
  });
}

/**
 * When the part 1 interaction of a record was created. For part-2 regenerations it is inherited, so
 * the record's own createdAt is too recent: look it up in the spend ledger (kept even when
 * generations are deleted), else walk up the parent chain.
 */
export async function resolvePart1CreatedAt(ctx: AppContext, g: GenerationRecord): Promise<Date> {
  if (g.regenerationMode !== 'part2' || !g.part1InteractionId) return g.createdAt;
  try {
    const { rows } = await ctx.db.query<{ at: Date | string | null }>(
      'SELECT MIN(created_at) AS at FROM api_calls WHERE interaction_id = $1',
      [g.part1InteractionId],
    );
    const at = rows[0]?.at;
    if (at) return at instanceof Date ? at : new Date(at);
  } catch (err) {
    ctx.logger.warn({ err, generationId: g.id }, 'could not read the part 1 interaction time from the ledger');
  }
  let current = g;
  for (let hop = 0; hop < 25 && current.regenerationMode === 'part2' && current.parentId; hop++) {
    const parent = await ctx.repo.get(current.parentId);
    if (!parent || parent.part1InteractionId !== g.part1InteractionId) break;
    current = parent;
  }
  return current.createdAt;
}
