import type { AppConfig } from '../config.js';
import type { UsageInfo } from '../core/ports.js';
import type { CostBreakdown, CostLineItem, RegenerationMode, Resolution } from '../shared/api.js';
import { SEGMENT_SECONDS } from '../shared/api.js';

export type PricingConfig = AppConfig['pricing'];

/** Rough prompt size of one Omni turn (continuity bible + dialogue + directions). */
const PROMPT_TOKENS_PER_TURN = 450;

const round4 = (n: number) => Math.round(n * 1e4) / 1e4;

function item(label: string, quantity: number, unit: string, unitPriceUsd: number): CostLineItem {
  return { label, quantity, unit, unitPriceUsd, amountUsd: round4(quantity * unitPriceUsd) };
}

function total(items: CostLineItem[]): number {
  return round4(items.reduce((sum, i) => sum + i.amountUsd, 0));
}

export interface EstimateInput {
  resolution: Resolution;
  /** `full` (default) = split + part 1 + part 2, `part2` = only the extension turn. */
  mode?: RegenerationMode;
  /** Whether the script still needs the LLM splitter (false when the user supplied a reviewed plan). */
  needsSplit?: boolean;
  /** Whether the character image is re-sent in the extension turn. */
  reinforceCharacterOnExtend?: boolean;
}

export function estimateCost(pricing: PricingConfig, input: EstimateInput): CostBreakdown {
  const mode = input.mode ?? 'full';
  const tps = pricing.videoTokensPerSecond[input.resolution];
  const videoTokenPrice = pricing.videoOutputUsdPerMillionTokens / 1e6;
  const inputTokenPrice = pricing.inputUsdPerMillionTokens / 1e6;
  const textTokenPrice = pricing.textOutputUsdPerMillionTokens / 1e6;
  const items: CostLineItem[] = [];
  const notes: string[] = [];

  if (mode === 'full' && (input.needsSplit ?? true)) {
    items.push(item('Script split (text model)', 1, 'call', pricing.splitterUsdPerCallEstimate));
  }

  if (mode === 'full') {
    items.push(
      item(
        `Part 1 video output (${SEGMENT_SECONDS}s @ ${input.resolution})`,
        SEGMENT_SECONDS * tps,
        'video tokens',
        videoTokenPrice,
      ),
      item('Part 1 prompt processing (text + thinking)', pricing.turnTextOutputTokens, 'text tokens', textTokenPrice),
      item(
        'Part 1 input (character image + prompt)',
        pricing.imageInputTokens + PROMPT_TOKENS_PER_TURN,
        'input tokens',
        inputTokenPrice,
      ),
    );
  }

  const extensionOutputSeconds = pricing.extensionBilling === 'full_output' ? SEGMENT_SECONDS * 2 : SEGMENT_SECONDS;
  items.push(
    item(
      `Part 2 extension output (${extensionOutputSeconds}s @ ${input.resolution})`,
      extensionOutputSeconds * tps,
      'video tokens',
      videoTokenPrice,
    ),
  );

  // The extension turn carries the previous turn (image, prompt and 10s of video) as context.
  const contextTokens =
    SEGMENT_SECONDS * pricing.videoInputTokensPerSecond +
    pricing.imageInputTokens * (input.reinforceCharacterOnExtend ? 2 : 1) +
    PROMPT_TOKENS_PER_TURN * 2;
  items.push(
    item('Part 2 input (previous turn context + prompt)', contextTokens, 'input tokens', inputTokenPrice),
    item('Part 2 prompt processing (text + thinking)', pricing.turnTextOutputTokens, 'text tokens', textTokenPrice),
  );

  notes.push(
    `Video output billed at $${pricing.videoOutputUsdPerMillionTokens}/1M tokens (~$${pricing.videoOutputUsdPerSecond[input.resolution].toFixed(3)}/s at ${input.resolution}).`,
  );
  if (pricing.extensionBilling === 'full_output') {
    notes.push('Extension billed for the full returned video (EXTENSION_BILLING=full_output).');
  }
  notes.push('Retries after transient API errors can add cost. Actual cost is computed from reported token usage.');

  return { currency: 'USD', items, totalUsd: total(items), basis: 'estimate', notes };
}

/** Cost of one video turn from reported usage. Returns null when usage has no token counts. */
export function turnCostFromUsage(
  pricing: PricingConfig,
  usage: UsageInfo | null,
): { usd: number; items: CostLineItem[] } | null {
  if (!usage) return null;
  const hasCounts =
    usage.outputTokens !== undefined || usage.videoOutputTokens !== undefined || usage.inputTokens !== undefined;
  if (!hasCounts) return null;
  const videoTokenPrice = pricing.videoOutputUsdPerMillionTokens / 1e6;
  const textTokenPrice = pricing.textOutputUsdPerMillionTokens / 1e6;
  const inputTokenPrice = pricing.inputUsdPerMillionTokens / 1e6;

  const outputTotal = usage.outputTokens ?? 0;
  const videoOut = usage.videoOutputTokens ?? Math.max(outputTotal - (usage.textOutputTokens ?? 0), 0);
  const textOut = (usage.textOutputTokens ?? Math.max(outputTotal - videoOut, 0)) + (usage.thoughtTokens ?? 0);
  const input = usage.inputTokens ?? 0;

  const items: CostLineItem[] = [];
  if (videoOut > 0) items.push(item('video output', videoOut, 'video tokens', videoTokenPrice));
  if (textOut > 0) items.push(item('text output', textOut, 'text tokens', textTokenPrice));
  if (input > 0) items.push(item('input', input, 'input tokens', inputTokenPrice));
  return { usd: total(items), items };
}

export interface ActualCostInput {
  resolution: Resolution;
  splitCostUsd: number | null;
  part1: { usage: UsageInfo | null; completed: boolean } | null;
  part2: { usage: UsageInfo | null; completed: boolean } | null;
}

/**
 * Actual cost from usage. When a completed turn reported no usage, the estimate for that turn is
 * used and a note says so.
 */
export function actualCost(pricing: PricingConfig, input: ActualCostInput): CostBreakdown {
  const items: CostLineItem[] = [];
  const notes: string[] = [];
  let estimated = false;

  if (input.splitCostUsd !== null && input.splitCostUsd > 0) {
    items.push(item('Script split (text model)', 1, 'call', round4(input.splitCostUsd)));
  }

  const addTurn = (label: string, turn: ActualCostInput['part1'], fallback: () => CostLineItem[]) => {
    if (!turn) return;
    const fromUsage = turnCostFromUsage(pricing, turn.usage);
    if (fromUsage) {
      for (const i of fromUsage.items) items.push({ ...i, label: `${label} ${i.label}` });
    } else if (turn.completed) {
      estimated = true;
      items.push(...fallback());
    }
  };

  const estimateFull = estimateCost(pricing, { resolution: input.resolution, mode: 'full', needsSplit: false });
  const part1Items = estimateFull.items.filter((i) => i.label.startsWith('Part 1'));
  const part2Items = estimateFull.items.filter((i) => i.label.startsWith('Part 2'));
  addTurn('Part 1', input.part1, () => part1Items);
  addTurn('Part 2', input.part2, () => part2Items);

  if (estimated) notes.push('Some turns reported no token usage; their cost is estimated from list prices.');
  notes.push(`Prices: ${pricing.source}.`);
  return { currency: 'USD', items, totalUsd: total(items), basis: estimated ? 'estimate' : 'actual', notes };
}

/** Normalizes the SDK `Usage` object (snake_case, per-modality arrays) into `UsageInfo`. */
export function normalizeUsage(raw: unknown): UsageInfo | null {
  if (!raw || typeof raw !== 'object') return null;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
  const byModality = (v: unknown): Map<string, number> => {
    const m = new Map<string, number>();
    if (Array.isArray(v)) {
      for (const entry of v) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const modality = String(e.modality ?? '').toLowerCase();
        const tokens = num(e.tokens) ?? num(e.token_count) ?? num(e.tokenCount);
        if (modality && tokens !== undefined) m.set(modality, (m.get(modality) ?? 0) + tokens);
      }
    }
    return m;
  };
  const out = byModality(u.output_tokens_by_modality ?? u.outputTokensByModality);
  const inp = byModality(u.input_tokens_by_modality ?? u.inputTokensByModality);
  const pick = (m: Map<string, number>, key: string) => (m.size ? (m.get(key) ?? 0) : undefined);

  const info: UsageInfo = {
    inputTokens: num(u.total_input_tokens ?? u.totalInputTokens),
    outputTokens: num(u.total_output_tokens ?? u.totalOutputTokens),
    totalTokens: num(u.total_tokens ?? u.totalTokens),
    videoOutputTokens: out.size ? (out.get('video') ?? 0) + (out.get('audio') ?? 0) : undefined,
    textOutputTokens: pick(out, 'text'),
    thoughtTokens: num(u.total_thought_tokens ?? u.totalThoughtTokens),
    videoInputTokens: pick(inp, 'video'),
    imageInputTokens: pick(inp, 'image'),
    textInputTokens: pick(inp, 'text'),
    raw,
  };
  return info;
}
