/** Data hooks (TanStack Query) and small UI hooks shared by the pages. */
import {
  keepPreviousData,
  useInfiniteQuery,
  useQuery,
  type InfiniteData,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import {
  isTerminalStatus,
  type GenerationListResponse,
  type GenerationStatus,
  type RegenerationMode,
  type Resolution,
} from '@shared/api';
import { estimateCost, getConfig, getGeneration, getSession, isApiError, listGenerations } from './api';

export const GENERATION_POLL_MS = 2000;
export const HISTORY_POLL_MS = 4000;
export const HISTORY_PAGE_SIZE = 24;

export const queryKeys = {
  session: ['session'] as const,
  config: ['config'] as const,
  generations: ['generations'] as const,
  generationList: (status: GenerationStatus | 'all') => ['generations', 'list', status] as const,
  generation: (id: string) => ['generation', id] as const,
  estimate: (resolution: Resolution, mode: RegenerationMode, reinforceCharacterOnExtend: boolean) =>
    ['estimate', resolution, mode, reinforceCharacterOnExtend] as const,
};

export function useSession() {
  return useQuery({
    queryKey: queryKeys.session,
    queryFn: ({ signal }) => getSession(signal),
    staleTime: 5 * 60_000,
  });
}

export function useAppConfig() {
  return useQuery({
    queryKey: queryKeys.config,
    queryFn: ({ signal }) => getConfig(signal),
    staleTime: 30_000,
    // Keeps the daily budget pill reasonably fresh.
    refetchInterval: 60_000,
  });
}

/** Loads one generation and polls every 2s while it is queued or running. */
export function useGeneration(id: string | null | undefined, options: { poll?: boolean } = {}) {
  const poll = options.poll ?? true;
  return useQuery({
    queryKey: queryKeys.generation(id ?? ''),
    queryFn: ({ signal }) => getGeneration(id ?? '', signal),
    enabled: Boolean(id),
    refetchInterval: (query) => {
      const { data, error } = query.state;
      // Deleted (404) or signed out (401): polling again cannot succeed.
      if (isApiError(error) && (error.status === 404 || error.status === 401)) return false;
      return poll && data && !isTerminalStatus(data.status) ? GENERATION_POLL_MS : false;
    },
  });
}

function hasActiveItems(data: InfiniteData<GenerationListResponse> | undefined): boolean {
  return Boolean(data?.pages.some((page) => page.items.some((item) => !isTerminalStatus(item.status))));
}

/** Newest-first history with cursor pagination; polls every 4s while any loaded item is active. */
export function useGenerationList(status: GenerationStatus | 'all') {
  return useInfiniteQuery({
    queryKey: queryKeys.generationList(status),
    queryFn: ({ pageParam, signal }) =>
      listGenerations(
        { limit: HISTORY_PAGE_SIZE, cursor: pageParam, status: status === 'all' ? undefined : status },
        signal,
      ),
    initialPageParam: null as string | null,
    getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
    refetchInterval: (query) => (hasActiveItems(query.state.data) ? HISTORY_POLL_MS : false),
  });
}

export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), delayMs);
    return () => window.clearTimeout(timer);
  }, [value, delayMs]);
  return debounced;
}

export interface EstimateOptions {
  resolution: Resolution;
  mode?: RegenerationMode;
  /** Whether the extension turn re-sends the character image (adds image input tokens). */
  reinforceCharacterOnExtend?: boolean;
  enabled?: boolean;
}

/**
 * Cost estimate from POST /api/estimate, debounced by 300ms. `outdated` is true while the inputs
 * changed but the matching estimate has not arrived yet (the previous one is still shown).
 */
export function useEstimate({
  resolution,
  mode = 'full',
  reinforceCharacterOnExtend = false,
  enabled = true,
}: EstimateOptions) {
  const debouncedResolution = useDebouncedValue(resolution, 300);
  const debouncedReinforce = useDebouncedValue(reinforceCharacterOnExtend, 300);
  const query = useQuery({
    queryKey: queryKeys.estimate(debouncedResolution, mode, debouncedReinforce),
    queryFn: ({ signal }) =>
      estimateCost(
        { settings: { resolution: debouncedResolution, reinforceCharacterOnExtend: debouncedReinforce }, mode },
        signal,
      ),
    enabled,
    staleTime: 5 * 60_000,
    placeholderData: keepPreviousData,
  });
  const outdated =
    query.isPlaceholderData || debouncedResolution !== resolution || debouncedReinforce !== reinforceCharacterOnExtend;
  return { query, outdated };
}

/** Current time, refreshed every `intervalMs` while enabled (for elapsed timers). */
export function useNow(intervalMs = 1000, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), intervalMs);
    return () => window.clearInterval(timer);
  }, [intervalMs, enabled]);
  return now;
}

export function useDocumentTitle(title: string | null | undefined): void {
  useEffect(() => {
    const previous = document.title;
    document.title = title ? `${title} | Omni UGC Studio` : 'Omni UGC Studio';
    return () => {
      document.title = previous;
    };
  }, [title]);
}

/** Refreshes everything a new or finished generation affects (history list, budget). */
export function invalidateAfterGenerationChange(queryClient: QueryClient): void {
  void queryClient.invalidateQueries({ queryKey: queryKeys.generations });
  void queryClient.invalidateQueries({ queryKey: queryKeys.config });
}
