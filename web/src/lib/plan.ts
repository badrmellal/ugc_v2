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
 * Identifies the inputs a split was made from: the script and the settings that change what is said
 * or shown (the same list the server uses to decide whether a regeneration needs a new split).
 * Resolution, image mode and the part 2 image option only change how the prompts are rendered, and the
 * server rebuilds the prompts from the split fields anyway, so changing them never makes a preview stale.
 */
export function planBasisKey(script: string, settings: GenerationSettings): string {
  return JSON.stringify({
    script: script.trim(),
    style: settings.style,
    language: settings.language.trim(),
    voiceHint: settings.voiceHint.trim(),
    extraDirections: settings.extraDirections.trim(),
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

/**
 * The `plan` field of a full regeneration request (see RegenerateRequest):
 * - `undefined` (omitted): the split shown is the source video's own, untouched and still up to date, so
 *   the server keeps it (and rebuilds its prompts if only render settings changed) without re-labelling
 *   it as an edited split.
 * - a plan: a new preview or an edited split, used as is.
 * - `null`: no split (discarded, or an untouched preview that is out of date): the server splits the
 *   script again.
 */
export function planForRegenerate(
  plan: ScriptPlan | null,
  sourcePlan: ScriptPlan | null,
  opts: { stale: boolean; edited: boolean },
): ScriptPlan | null | undefined {
  const submitted = planForSubmit(plan, opts);
  if (!submitted) return null;
  if (submitted === sourcePlan && !opts.edited && !opts.stale) return undefined;
  return submitted;
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
