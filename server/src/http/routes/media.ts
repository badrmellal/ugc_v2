import type { Readable } from 'node:stream';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { GenerationRecord } from '../../core/ports.js';
import { errorBody, notFound } from '../errors.js';
import { downloadFileName, etagMatches, ifRangeAllows, parseRange, weakEtag, type RangeResult } from '../range.js';
import { isStorageNotFound } from '../../storage/index.js';
import { isUuid } from '../schemas.js';
import type { RouteDeps } from './types.js';

interface MediaKind {
  field: 'finalVideoKey' | 'part1VideoKey' | 'thumbnailKey' | 'characterImageKey';
  contentType: string;
  missing: string;
}

const MEDIA: Record<string, MediaKind> = {
  video: { field: 'finalVideoKey', contentType: 'video/mp4', missing: 'The final video is not ready yet.' },
  part1: { field: 'part1VideoKey', contentType: 'video/mp4', missing: 'Part 1 (0-10s) is not ready yet.' },
  thumbnail: { field: 'thumbnailKey', contentType: 'image/jpeg', missing: 'The thumbnail is not ready yet.' },
  character: { field: 'characterImageKey', contentType: 'image/jpeg', missing: 'The character image is missing.' },
};

/** Media is immutable per key; browsers may reuse it for an hour and revalidate with the ETag. */
const MEDIA_CACHE_CONTROL = 'private, max-age=3600';

function wantsDownload(query: unknown): boolean {
  const value = (query as Record<string, unknown> | undefined)?.download;
  return value === '1' || value === 'true';
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function registerMediaRoutes(app: FastifyInstance, deps: RouteDeps): void {
  const { ctx } = deps;

  const serve = async (kind: MediaKind, req: FastifyRequest<{ Params: { id: string } }>, reply: FastifyReply) => {
    const { id } = req.params;
    if (!isUuid(id)) throw notFound();
    const g: GenerationRecord | null = await ctx.repo.get(id);
    if (!g) throw notFound();
    const key = g[kind.field];
    if (!key) throw notFound(kind.missing);

    const fileName =
      kind.field === 'finalVideoKey' && wantsDownload(req.query) ? downloadFileName(g.title, g.id) : null;
    if (fileName) reply.header('content-disposition', `attachment; filename="${fileName}"`);

    const signedUrl = await ctx.storage.getSignedUrl(key, {
      ...(fileName ? { downloadFileName: fileName } : {}),
      contentType: kind.contentType,
    });
    if (signedUrl) {
      reply.removeHeader('content-disposition');
      return reply.header('cache-control', 'no-store').redirect(signedUrl, 302);
    }

    const info = await ctx.storage.stat(key);
    if (!info) throw notFound('The file is missing from storage.');
    const size = info.size;
    const etag = weakEtag(key, size);
    reply
      .header('accept-ranges', 'bytes')
      .header('etag', etag)
      .header('cache-control', MEDIA_CACHE_CONTROL)
      .header('content-type', info.contentType || kind.contentType);

    if (etagMatches(header(req.headers['if-none-match']), etag)) return reply.code(304).send();

    const range: RangeResult = ifRangeAllows(header(req.headers['if-range']), etag)
      ? parseRange(header(req.headers.range), size)
      : { kind: 'none' };
    if (range.kind === 'unsatisfiable') {
      reply.removeHeader('content-disposition');
      return reply
        .code(416)
        .header('content-range', `bytes */${size}`)
        .header('cache-control', 'no-store')
        .type('application/json; charset=utf-8')
        .send(errorBody('range_not_satisfiable', `The requested byte range is outside the file (${size} bytes).`));
    }

    const start = range.kind === 'range' ? range.start : 0;
    const end = range.kind === 'range' ? range.end : size - 1;
    const length = size === 0 ? 0 : end - start + 1;
    reply.code(range.kind === 'range' ? 206 : 200).header('content-length', String(length));
    if (range.kind === 'range') reply.header('content-range', `bytes ${start}-${end}/${size}`);
    if (req.method === 'HEAD' || length === 0) return reply.send();

    let stream: Readable;
    try {
      stream = await ctx.storage.createReadStream(key, range.kind === 'range' ? { start, end } : undefined);
    } catch (err) {
      if (isStorageNotFound(err)) throw notFound('The file is missing from storage.');
      throw err;
    }
    // Release the storage stream (file handle or S3 socket) as soon as the client goes away.
    const release = () => {
      if (!stream.destroyed) stream.destroy();
    };
    reply.raw.once('close', release);
    if (req.raw.destroyed) release();
    return reply.send(stream);
  };

  for (const [name, kind] of Object.entries(MEDIA)) {
    app.route<{ Params: { id: string } }>({
      method: ['GET', 'HEAD'],
      url: `/api/generations/:id/${name}`,
      handler: (req, reply) => serve(kind, req, reply),
    });
  }
}
