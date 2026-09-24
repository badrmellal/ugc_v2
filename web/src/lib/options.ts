/** UI copy and option lists for generation settings. */
import {
  SEGMENT_SECONDS,
  TOTAL_SECONDS,
  type GenerationSettings,
  type ImageMode,
  type PricingInfo,
  type Resolution,
  type VideoStyle,
} from '@shared/api';

export const STYLE_OPTIONS: ReadonlyArray<{ value: VideoStyle; label: string; description: string }> = [
  { value: 'ugc', label: 'UGC', description: 'Handheld selfie-style creator talking to camera.' },
  { value: 'scientific', label: 'Scientific', description: 'Clear explainer presenter with a lab or studio look.' },
];

export const IMAGE_MODE_OPTIONS: ReadonlyArray<{ value: ImageMode; label: string; description: string }> = [
  {
    value: 'reference',
    label: 'Character reference',
    description: 'Recommended. Keeps the identity and builds the scene around the character.',
  },
  {
    value: 'first_frame',
    label: 'Use as first frame',
    description: 'The video opens on this exact image. Best when the photo is already a 9:16 shot.',
  },
];

export const RESOLUTION_LABELS: Record<Resolution, string> = {
  '360p': '360p',
  '720p': '720p',
  '1080p': '1080p',
  '4k': '4K',
};

export const STYLE_LABELS: Record<VideoStyle, string> = { ugc: 'UGC', scientific: 'Scientific' };

export const IMAGE_MODE_LABELS: Record<ImageMode, string> = {
  reference: 'Character reference',
  first_frame: 'First frame',
};

/**
 * Seconds of video output billed for one 20s video: 10s for part 1, plus 10s for the extension, or the
 * whole returned 20s clip when the extension is billed for its full output.
 */
export function billedVideoSeconds(pricing: Pick<PricingInfo, 'extensionBilling'>): number {
  return SEGMENT_SECONDS + (pricing.extensionBilling === 'full_output' ? TOTAL_SECONDS : SEGMENT_SECONDS);
}

/** Video output price for one 20s video at this resolution (input and text tokens not included). */
export function pricePerVideo(pricing: PricingInfo, resolution: Resolution): number {
  return (pricing.videoOutputUsdPerSecond[resolution] ?? 0) * billedVideoSeconds(pricing);
}

export const LANGUAGES: ReadonlyArray<{ code: string; label: string }> = [
  { code: 'en', label: 'English' },
  { code: 'en-US', label: 'English (US)' },
  { code: 'en-GB', label: 'English (UK)' },
  { code: 'es', label: 'Spanish' },
  { code: 'es-MX', label: 'Spanish (Mexico)' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'it', label: 'Italian' },
  { code: 'pt-BR', label: 'Portuguese (Brazil)' },
  { code: 'pt-PT', label: 'Portuguese (Portugal)' },
  { code: 'nl', label: 'Dutch' },
  { code: 'pl', label: 'Polish' },
  { code: 'sv', label: 'Swedish' },
  { code: 'da', label: 'Danish' },
  { code: 'nb', label: 'Norwegian' },
  { code: 'fi', label: 'Finnish' },
  { code: 'cs', label: 'Czech' },
  { code: 'ro', label: 'Romanian' },
  { code: 'el', label: 'Greek' },
  { code: 'tr', label: 'Turkish' },
  { code: 'ru', label: 'Russian' },
  { code: 'uk', label: 'Ukrainian' },
  { code: 'ar', label: 'Arabic' },
  { code: 'he', label: 'Hebrew' },
  { code: 'fa', label: 'Persian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'bn', label: 'Bengali' },
  { code: 'ur', label: 'Urdu' },
  { code: 'id', label: 'Indonesian' },
  { code: 'ms', label: 'Malay' },
  { code: 'th', label: 'Thai' },
  { code: 'vi', label: 'Vietnamese' },
  { code: 'fil', label: 'Filipino' },
  { code: 'zh-CN', label: 'Chinese (Simplified)' },
  { code: 'zh-TW', label: 'Chinese (Traditional)' },
  { code: 'ja', label: 'Japanese' },
  { code: 'ko', label: 'Korean' },
  { code: 'sw', label: 'Swahili' },
];

export function isKnownLanguage(code: string): boolean {
  return LANGUAGES.some((language) => language.code === code);
}

export function languageLabel(code: string): string {
  return LANGUAGES.find((language) => language.code === code)?.label ?? code;
}

/** BCP-47 shape check (`en`, `pt-BR`, `zh-Hant-TW`), the same pattern the server validates with. */
export function isValidLanguageTag(tag: string): boolean {
  return /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8}){0,3}$/.test(tag.trim());
}

export function settingsSummary(settings: GenerationSettings): string {
  return [
    STYLE_LABELS[settings.style],
    RESOLUTION_LABELS[settings.resolution],
    IMAGE_MODE_LABELS[settings.imageMode],
    languageLabel(settings.language),
  ].join(' · ');
}
