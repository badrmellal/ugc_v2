/** Keeps the unsent script and settings in this browser so a reload does not lose them. */
import { IMAGE_MODES, RESOLUTIONS, VIDEO_STYLES, type GenerationSettings } from '@shared/api';

const KEY = 'omni-ugc:create-draft:v1';

export interface Draft {
  script: string;
  settings: Partial<GenerationSettings>;
}

function includes<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value);
}

/** Applies stored values over `base`, ignoring anything malformed or outdated. */
export function mergeSettings(base: GenerationSettings, stored: Partial<Record<keyof GenerationSettings, unknown>>) {
  const next: GenerationSettings = { ...base };
  if (includes(VIDEO_STYLES, stored.style)) next.style = stored.style;
  if (includes(RESOLUTIONS, stored.resolution)) next.resolution = stored.resolution;
  if (includes(IMAGE_MODES, stored.imageMode)) next.imageMode = stored.imageMode;
  if (typeof stored.language === 'string' && stored.language.trim()) next.language = stored.language;
  if (typeof stored.voiceHint === 'string') next.voiceHint = stored.voiceHint;
  if (typeof stored.extraDirections === 'string') next.extraDirections = stored.extraDirections;
  if (typeof stored.reinforceCharacterOnExtend === 'boolean') {
    next.reinforceCharacterOnExtend = stored.reinforceCharacterOnExtend;
  }
  return next;
}

export function loadDraft(): Draft | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const { script, settings } = parsed as { script?: unknown; settings?: unknown };
    return {
      script: typeof script === 'string' ? script : '',
      settings: typeof settings === 'object' && settings !== null ? (settings as Partial<GenerationSettings>) : {},
    };
  } catch {
    return null;
  }
}

export function saveDraft(draft: Draft): void {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(draft));
  } catch {
    // Storage can be unavailable (private mode, quota). The draft is a convenience only.
  }
}

export function clearDraft(): void {
  try {
    window.localStorage.removeItem(KEY);
  } catch {
    // Ignore: see saveDraft.
  }
}
