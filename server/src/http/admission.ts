import type { Db } from '../db/pool.js';
import { GenerationRepository } from '../db/repository.js';

/**
 * Key of the cluster-wide admission lock, for pg_advisory_xact_lock(int, int). The namespace differs
 * from the Omni turn limiter's (7_214_553).
 */
const ADMISSION_LOCK = [7_214_554, 1] as const;
/** Fail instead of queueing forever behind a stuck holder (surfaces as a 500 with a request id). */
const LOCK_TIMEOUT = '15s';

/**
 * Runs `fn` inside one transaction that holds a cluster-wide advisory lock, with a repository bound
 * to that transaction. Admission (queue and budget checks, then the insert) and deletion (shared-file
 * check, then the delete) go through it, so across every API instance:
 * - concurrent requests cannot overshoot MAX_QUEUED_JOBS or DAILY_BUDGET_USD;
 * - a regeneration never starts to reference the files of a generation that is being deleted.
 *
 * The lock is released on commit or rollback, and by Postgres if the connection dies.
 */
export async function withAdmissionLock<T>(db: Db, fn: (repo: GenerationRepository) => Promise<T>): Promise<T> {
  const client = await db.connect();
  let broken = false;
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT}'`);
    await client.query('SELECT pg_advisory_xact_lock($1, $2)', [...ADMISSION_LOCK]);
    // GenerationRepository only calls `query`, which a pool client provides with the same signature
    // as the pool, so every statement below runs inside this transaction.
    const result = await fn(new GenerationRepository(client as unknown as Db));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw err;
  } finally {
    // A connection that could not roll back is discarded instead of being reused mid-transaction.
    client.release(broken);
  }
}
