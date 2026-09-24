import type { Logger } from 'pino';

const KEY = 'omni_unsupported_transports';
/** Rejections expire so a transient API behaviour cannot pin the cluster to a fallback forever. */
const TTL_MS = 7 * 24 * 60 * 60 * 1000;

type Transport = 'stream' | 'background' | 'blocking';

interface Entry {
  transport: Transport;
  at: string;
  reason: string;
}

/**
 * Persists which Omni transports the API rejected (app_state), so every worker and every restart
 * skips them instead of losing another turn to discover the same thing.
 */
export interface AppStateStore {
  getAppState(key: string): Promise<unknown>;
  setAppState(key: string, value: unknown): Promise<void>;
}

export function createTransportStore(repo: AppStateStore, logger: Logger) {
  let cache: { at: number; value: Transport[] } | null = null;

  async function read(): Promise<Entry[]> {
    const raw = await repo.getAppState(KEY);
    if (!Array.isArray(raw)) return [];
    const now = Date.now();
    return raw.filter((e): e is Entry => {
      if (!e || typeof e !== 'object') return false;
      const entry = e as Partial<Entry>;
      const at = Date.parse(String(entry.at));
      return (
        (entry.transport === 'stream' || entry.transport === 'background') && Number.isFinite(at) && now - at < TTL_MS
      );
    });
  }

  return {
    async loadUnsupportedTransports(): Promise<Transport[]> {
      // One query per minute at most; turns are minutes apart anyway.
      if (cache && Date.now() - cache.at < 60_000) return cache.value;
      const value = (await read()).map((e) => e.transport);
      cache = { at: Date.now(), value };
      return value;
    },
    onTransportRejected(transport: Transport, reason: string): void {
      if (transport === 'blocking') return;
      void (async () => {
        const entries = (await read()).filter((e) => e.transport !== transport);
        entries.push({ transport, at: new Date().toISOString(), reason: reason.slice(0, 300) });
        await repo.setAppState(KEY, entries);
        cache = null;
        logger.warn({ transport }, 'persisted unusable Omni transport for all workers (expires in 7 days)');
      })().catch((err: unknown) => logger.warn({ err }, 'could not persist Omni transport rejection'));
    },
  };
}
