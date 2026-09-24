/**
 * Builds an ASS subtitle script for TikTok-style burned-in captions: short groups of 1-3 words in
 * bold white uppercase with a thick black outline, where the word being spoken turns yellow and pops.
 */

export interface CaptionWord {
  /** Word as written in the script (may carry punctuation). */
  text: string;
  start: number;
  end: number;
}

export interface CaptionStyle {
  fontName: string;
  /** Active word colour as #RRGGBB. */
  highlight: string;
  uppercase: boolean;
  maxWordsPerGroup: number;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  fontName: 'Poppins ExtraBold',
  highlight: '#FFD400',
  uppercase: true,
  maxWordsPerGroup: 3,
};

/** Keeps a caption group on screen this long after its last word, unless the next group starts. */
const HOLD_SEC = 0.35;
/** Groups break after sentence or clause punctuation. */
const BREAK_AFTER = /[.,!?;:]["')\]]*$/;

/** ASS colour override (&HBBGGRR&) from #RRGGBB. */
export function assColor(hex: string): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
  if (!m) throw new Error(`Invalid colour ${hex}`);
  return `&H${m[3]}${m[2]}${m[1]}&`.toUpperCase();
}

/** h:mm:ss.cc as ASS expects. */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100));
  const h = Math.floor(cs / 360000);
  const m = Math.floor((cs % 360000) / 6000);
  const s = Math.floor((cs % 6000) / 100);
  const c = cs % 100;
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`;
}

/** Word as shown: punctuation that adds noise on screen is dropped, ? and ! are kept. */
export function displayWord(text: string, uppercase: boolean): string {
  const cleaned = text
    .replace(/[“”"]/g, '')
    .replace(/^[([{'‘]+|[)\]}'’]+$/g, '')
    .replace(/[.,;:]+$/g, '')
    .trim();
  const shown = cleaned || text.trim();
  return uppercase ? shown.toLocaleUpperCase() : shown;
}

function escapeAss(text: string): string {
  // Braces start override blocks and a backslash starts a tag: neutralize both.
  return text.replace(/\\/g, '∖').replace(/[{}]/g, '');
}

/** Splits words into on-screen groups that fit the frame width. */
export function groupWords(words: CaptionWord[], maxWords: number, maxChars: number): CaptionWord[][] {
  const groups: CaptionWord[][] = [];
  let current: CaptionWord[] = [];
  let chars = 0;
  for (const word of words) {
    const len = word.text.length;
    const gap = current.length ? word.start - current[current.length - 1]!.end : 0;
    if (current.length && (current.length >= maxWords || chars + 1 + len > maxChars || gap > 0.6)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
    current.push(word);
    chars += (current.length > 1 ? 1 : 0) + len;
    if (BREAK_AFTER.test(word.text)) {
      groups.push(current);
      current = [];
      chars = 0;
    }
  }
  if (current.length) groups.push(current);
  return groups;
}

/** Cleans timings: sorted, non-negative, every word at least 80ms long, no overlaps. */
export function normalizeTimings(words: CaptionWord[]): CaptionWord[] {
  const sorted = words
    .filter((w) => w.text.trim() && Number.isFinite(w.start) && Number.isFinite(w.end))
    .map((w) => ({ ...w, start: Math.max(0, w.start), end: Math.max(0, w.end) }))
    .sort((a, b) => a.start - b.start);
  for (let i = 0; i < sorted.length; i += 1) {
    const w = sorted[i]!;
    const next = sorted[i + 1];
    if (w.end < w.start + 0.08) w.end = w.start + 0.08;
    if (next && w.end > next.start) w.end = Math.max(w.start + 0.04, next.start);
  }
  return sorted;
}

export function buildAss(
  rawWords: CaptionWord[],
  video: { width: number; height: number; durationSec: number },
  style: CaptionStyle = DEFAULT_CAPTION_STYLE,
): string {
  const { width, height } = video;
  // Group on the original text (its punctuation marks sentence breaks), strip punctuation when drawing.
  const words = normalizeTimings(rawWords);
  const fontSize = Math.round(height * 0.058);
  const outline = Math.max(2, Math.round(fontSize * 0.1));
  const shadow = Math.max(1, Math.round(fontSize * 0.05));
  const marginX = Math.round(width * 0.07);
  // Above the bottom area where TikTok/Reels/Shorts draw their buttons and descriptions.
  const marginV = Math.round(height * 0.3);
  // Bold uppercase glyphs average about 0.72em wide.
  const maxChars = Math.max(6, Math.floor((width - 2 * marginX) / (fontSize * 0.72)));
  const highlight = assColor(style.highlight);

  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${width}`,
    `PlayResY: ${height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    `Style: Caption,${style.fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&H78000000,0,0,0,0,100,100,1,0,1,${outline},${shadow},2,${marginX},${marginX},${marginV},1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
  ];

  const events: string[] = [];
  const groups = groupWords(words, style.maxWordsPerGroup, maxChars);
  groups.forEach((group, gi) => {
    const nextStart = groups[gi + 1]?.[0]?.start ?? Number.POSITIVE_INFINITY;
    const groupEnd = Math.min(group[group.length - 1]!.end + HOLD_SEC, nextStart, video.durationSec);
    group.forEach((word, wi) => {
      const start = word.start;
      const end = wi === group.length - 1 ? groupEnd : group[wi + 1]!.start;
      if (end - start < 0.01) return;
      const text = group
        .map((w, i) => {
          const shown = escapeAss(displayWord(w.text, style.uppercase));
          return i === wi ? `{\\c${highlight}\\fscx112\\fscy112}${shown}{\\r}` : shown;
        })
        .join(' ');
      events.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,${text}`);
    });
  });

  return [...header, ...events, ''].join('\n');
}
