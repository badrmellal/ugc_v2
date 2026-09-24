/**
 * Content themes. A theme is independent of the delivery style (UGC selfie or science explainer): it
 * supplies the default location, on-camera role and ambience of the continuity bible, and tells the
 * script splitter which subject rules apply. Edit the texts here to adjust a theme.
 */
import type { GenerationSettings, VideoStyle, VideoTheme } from '../shared/api.js';

export interface ThemePreset {
  /** Subject context and rules for the script splitter. */
  brief: string;
  /** Per-style overrides of the continuity bible defaults (the look itself comes from the image). */
  character?: Record<VideoStyle, string>;
  setting?: Record<VideoStyle, string>;
  audio?: Record<VideoStyle, string>;
}

export const THEME_PRESETS: Record<VideoTheme, ThemePreset> = {
  general: {
    brief: 'No specific theme: follow the script.',
  },
  bandys_cars: {
    brief:
      'Automotive content for Bandys Cars, a car dealership: vehicle walkarounds, test-drive impressions, deals, financing tips, trade-ins and customer testimonials. Write the brand exactly as "Bandys Cars". Cars are generic modern vehicles with no visible third-party logos or badges. Never invent car makes, models, prices, mileage or specifications that the script does not state.',
    character: {
      ugc: 'a friendly, trustworthy car enthusiast with an upbeat, genuine manner, smart casual look',
      scientific:
        'a knowledgeable, approachable automotive expert with a confident, clear manner, neat professional look',
    },
    setting: {
      ugc: 'the Bandys Cars dealership lot on a bright sunny day, rows of clean, polished modern cars parked behind the person and a storefront sign that reads "Bandys Cars"',
      scientific:
        'inside the bright, modern Bandys Cars showroom with polished cars on display, a glossy floor and a wall sign that reads "Bandys Cars"',
    },
    audio: {
      ugc: 'clean close-mic speech with light outdoor ambience and faint distant traffic',
      scientific: 'crisp, clean speech with quiet showroom ambience',
    },
  },
  tech_ai_robotics: {
    brief:
      'Technology, artificial intelligence and robotics content: AI tools and models, gadgets, robots, automation and the future of work. Keep every technical claim exactly as the script states it; never invent specifications, benchmarks, dates, company or product names.',
    character: {
      ugc: 'an enthusiastic, curious tech creator with an energetic, friendly manner, casual modern look',
      scientific: 'a calm, precise robotics and AI engineer with a clear, trustworthy manner, neat professional look',
    },
    setting: {
      ugc: 'a modern home tech studio desk with monitors showing abstract code and data charts, a small desktop robotic arm at rest and cool blue and purple LED accent lighting',
      scientific:
        'a clean, bright robotics lab with a white industrial robotic arm at rest and a humanoid robot standing still in the background, screens with abstract data visualizations and cool even lighting',
    },
    audio: {
      ugc: 'clean close-mic speech with quiet room tone and a faint hum of electronics',
      scientific: 'crisp, clean speech with quiet lab ambience and a faint hum of electronics',
    },
  },
};

export function themeOf(settings: Pick<GenerationSettings, 'theme'>): VideoTheme {
  return settings.theme in THEME_PRESETS ? settings.theme : 'general';
}

/** Continuity bible defaults for a style + theme (theme values win over the style defaults). */
export function themedDefaults<T extends { character: string; setting: string; audio: string }>(
  styleDefaults: T,
  settings: Pick<GenerationSettings, 'style' | 'theme'>,
): T {
  const preset = THEME_PRESETS[themeOf(settings)];
  return {
    ...styleDefaults,
    character: preset.character?.[settings.style] ?? styleDefaults.character,
    setting: preset.setting?.[settings.style] ?? styleDefaults.setting,
    audio: preset.audio?.[settings.style] ?? styleDefaults.audio,
  };
}
