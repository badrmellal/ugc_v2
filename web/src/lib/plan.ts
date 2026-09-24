/** Helpers for reviewing and editing the two-part script split. */
import type { GenerationSettings, ScriptPlan, SegmentPlan } from '@shared/api';

export type BibleField = 'character' | 'setting' | 'voice' | 'audio';
export type SegmentField = 'dialogue' | 'action' | 'camera' | 'onScreenText';
export type SegmentEdits = Pick<SegmentPlan, SegmentField>;

export const BIBLE_FIELDS: ReadonlyArray<{ field: BibleField; label: string; hint: string }> = [
  { field: 'character', label: 'Character', hint: 'Appearance, wardrobe and manner, kept identical in both parts.' },
  { field: 'setting', label: 'Setting', hint: 'Location, lighting and props.' },
  { field: 'voice', label: 'Voice', hint: 'Voice timbre, accent, energy and delivery.' },
  { field: 'audio', label: 'Audio', hint: 'Room tone, ambience and music, if any.' },
];

export const SEGMENT_FIELDS: ReadonlyArray<{ field: SegmentField; label: string; multiline: boolean }> = [
  { field: 'dialogue', label: 'Dialogue', multiline: true },
  { field: 'action', label: 'Action', multiline: true },
  { field: 'camera', label: 'Camera', multiline: false },
  { field: 'onScreenText', label: 'On-screen text', multiline: false },
];

export const PLAN_SOURCE_LABELS: Record<ScriptPlan['source'], string> = {
  llm: 'Automatic split',
  fallback: 'Rule-based split',
  user: 'Edited split',
};

export function updateBibleField(plan: ScriptPlan, field: BibleField, value: string): ScriptPlan {
  return { ...plan, [field]: value, source: 'user' };
}

export function updateSegmentField(plan: ScriptPlan, index: 0 | 1, field: SegmentField, value: string): ScriptPlan {
  const segments: [SegmentPlan, SegmentPlan] = [plan.segments[0], plan.segments[1]];
  segments[index] = { ...segments[index], [field]: value };
  return { ...plan, segments, source: 'user' };
}

/**
 * Identifies the inputs a split was made from. Resolution does not change the prompts,
 * so it is left out and switching resolution never marks a preview as stale.
 */
export function planBasisKey(script: string, settings: GenerationSettings): string {
  return JSON.stringify({
    script: script.trim(),
    style: settings.style,
    imageMode: settings.imageMode,
    language: settings.language.trim(),
    voiceHint: settings.voiceHint.trim(),
    extraDirections: settings.extraDirections.trim(),
    reinforceCharacterOnExtend: settings.reinforceCharacterOnExtend,
  });
}

/**
 * Decides which plan to send when generating.
 * - no plan: `undefined` (let the server split).
 * - up to date, or edited by the user: the plan as is (edits are never silently dropped).
 * - out of date and untouched: `undefined` so the server splits the current script again.
 */
export function planForSubmit(
  plan: ScriptPlan | null,
  opts: { stale: boolean; edited: boolean },
): ScriptPlan | undefined {
  if (!plan) return undefined;
  if (opts.stale && !opts.edited) return undefined;
  return plan;
}

/** Returns only the part 2 fields that differ from the original (compared after trimming). */
export function diffSegmentEdits(original: SegmentPlan | null | undefined, edits: SegmentEdits): Partial<SegmentEdits> {
  const changes: Partial<SegmentEdits> = {};
  for (const { field } of SEGMENT_FIELDS) {
    const next = edits[field].trim();
    const before = (original?.[field] ?? '').trim();
    if (next !== before) changes[field] = next;
  }
  return changes;
}
