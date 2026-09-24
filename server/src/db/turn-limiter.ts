import type { PoolClient } from 'pg';
import type { Db } from './pool.js';

/** Namespace (first key) for pg_try_advisory_lock(int, int); the slot number is the second key. */
const LOCK_NAMESPACE = 7_214_553;
const RETRY_MS = 2000;

export interface TurnLimiter {
  /** Waits for a free slot. The returned function releases it (idempotent). */
  acquire(signal: AbortSignal): Promise<() => Promise<void>>;
}

/**
 * Cluster-wide cap on concurrent Omni turns, shared by every worker process through Postgres
 * session-level advisory locks. A crashed process releases its slot automatically when its
 * connection closes. Needed because parallel Omni streams on one API key are reported to be cut.
 */
export class PgTurnLimiter implements TurnLimiter {
  constructor(
    private readonly db: Db,
    private readonly slots: number,
  ) {}

  async acquire(signal: AbortSignal): Promise<() => Promise<void>> {
    for (;;) {
      for (let slot = 0; slot < this.slots; slot += 1) {
        if (signal.aborted) throw abortReason(signal);
        const client = await this.db.connect();
        let locked = false;
        try {
          const { rows } = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1, $2) AS ok', [
            LOCK_NAMESPACE,
            slot,
          ]);
          locked = Boolean(rows[0]?.ok);
        } finally {
          if (!locked) client.release();
        }
        if (locked) return releaser(client, slot);
      }
      await wait(RETRY_MS, signal);
    }
  }
}

/** No-op limiter for tests and single-tenant setups without a cap. */
export const unlimitedTurns: TurnLimiter = {
  async acquire() {
    return async () => undefined;
  },
};

function releaser(client: PoolClient, slot: number): () => Promise<void> {
  let released = false;
  return async () => {
    if (released) return;
    released = true;
    try {
      await client.query('SELECT pg_advisory_unlock($1, $2)', [LOCK_NAMESPACE, slot]);
      client.release();
    } catch (err) {
      // Destroy the connection so the server drops the session lock.
      client.release(err instanceof Error ? err : true);
    }
  };
}

function abortReason(signal: AbortSignal): Error {
  const reason: unknown = signal.reason;
  return reason instanceof Error ? reason : new Error('aborted');
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
