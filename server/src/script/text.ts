/** Text helpers shared by the script splitter, the prompt builders and the planner. Pure functions. */

const EM_DASH = String.fromCharCode(0x2014);
const EM_DASH_RUN = new RegExp(`\\s*${EM_DASH}+\\s*`, 'g');
/** Omni media binding tags and declarations. Stripped from user text so it cannot rebind images. */
const OMNI_TAGS =
  /<\/?\s*(?:FIRST_FRAME|LAST_FRAME|PREVIOUS_VIDEO|IMAGE_REF_\d+|VIDEO_REF_\d+|VIDEO_\d+)\s*>|\[#\s*(?:Sources|References)[^\]]*\]/gi;

export const CJK_CHAR = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uAC00-\uD7AF\uF900-\uFAFF\uFF66-\uFF9F]/;

/** Removes C0/C1 control characters (except tab and newline), zero-width spaces and line separators. */
export function stripControlChars(s: string): string {
  let out = '';
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    const control = (c < 0x20 && c !== 0x09 && c !== 0x0a) || (c >= 0x7f && c <= 0x9f);
    if (control || c === 0x200b || c === 0x2028 || c === 0x2029 || c === 0xfeff) continue;
    out += ch;
  }
  return out;
}

/** Replaces em dashes (never sent anywhere) with a comma pause. */
export function replaceEmDashes(text: string): string {
  return text.replace(EM_DASH_RUN, (match: string, offset: number, whole: string) =>
    offset === 0 || offset + match.length === whole.length ? ' ' : ', ',
  );
}

export interface CleanOptions {
  /** Maximum length in characters (cut at a word boundary with an ellipsis). */
  max?: number;
  /** Keep newlines (collapsed to single `\n`) instead of flattening to spaces. */
  multiline?: boolean;
}

/** Normalizes user or model text: NFC, no control chars, no em dashes, no Omni tags, collapsed spaces. */
export function cleanText(input: unknown, opts: CleanOptions = {}): string {
  if (typeof input !== 'string') return '';
  let s = input.normalize('NFC').replace(/\r\n?/g, '\n');
  s = stripControlChars(s).replace(/\t/g, ' ');
  s = replaceEmDashes(s).replace(OMNI_TAGS, ' ');
  if (opts.multiline) {
    s = s
      .split('\n')
      .map((line) => line.replace(/ {2,}/g, ' ').trim())
      .join('\n')
      .replace(/\n{2,}/g, '\n')
      .trim();
  } else {
    s = s.replace(/\s+/g, ' ').trim();
  }
  if (opts.max && s.length > opts.max) s = truncate(s, opts.max);
  return s;
}

export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, Math.max(0, max - 3));
  const space = cut.lastIndexOf(' ');
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,;:.]+$/, '')}...`;
}

/** Makes a string safe to embed in a double-quoted span of the prompt. */
export function quoteSafe(s: string): string {
  return s
    .replace(/["\u201C\u201D\u201E\u00AB\u00BB]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** Ensures a clause ends with sentence punctuation. */
export function sentence(s: string): string {
  const t = s.trim();
  if (!t) return '';
  return /[.!?\u3002\uFF01\uFF1F]["')\]]*$/.test(t) ? t : `${t}.`;
}

/** Lowercases the first letter (for embedding a clause after "The person"). */
export function lowerFirst(s: string): string {
  return s ? s.charAt(0).toLowerCase() + s.slice(1) : s;
}

// ---------------------------------------------------------------------------
// Language
// ---------------------------------------------------------------------------

export function normalizeLanguage(tag: unknown): string {
  const t = typeof tag === 'string' ? tag.trim().replace(/_/g, '-') : '';
  if (!t) return 'en';
  try {
    return Intl.getCanonicalLocales(t)[0] ?? 'en';
  } catch {
    return /^[A-Za-z]{2,3}$/.test(t) ? t.toLowerCase() : 'en';
  }
}

export function isEnglish(tag: string): boolean {
  return /^en(?:-|$)/i.test(normalizeLanguage(tag));
}

/** English display name for a BCP-47 tag, e.g. `fr` -> `French`, `pt-BR` -> `Brazilian Portuguese`. */
export function languageName(tag: string): string {
  const t = normalizeLanguage(tag);
  try {
    return new Intl.DisplayNames(['en'], { type: 'language' }).of(t) ?? t;
  } catch {
    return t;
  }
}

// ---------------------------------------------------------------------------
// Token comparison (used to verify that a split kept the script verbatim)
// ---------------------------------------------------------------------------

/** Lowercased word tokens; CJK characters are individual tokens; punctuation is ignored. */
export function normalizedTokens(text: string): string[] {
  const s = text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u2018\u2019\u02BC`']/g, '');
  const out: string[] = [];
  for (const chunk of s.split(/[^\p{L}\p{N}\p{M}]+/u)) {
    if (!chunk) continue;
    if (CJK_CHAR.test(chunk)) {
      let buf = '';
      for (const ch of chunk) {
        if (CJK_CHAR.test(ch)) {
          if (buf) out.push(buf);
          buf = '';
          out.push(ch);
        } else {
          buf += ch;
        }
      }
      if (buf) out.push(buf);
    } else {
      out.push(chunk);
    }
  }
  return out;
}

/** Length of the longest common subsequence of two token lists (order-preserving overlap). */
export function lcsLength(a: string[], b: string[]): number {
  // A shared prefix and suffix always belong to a longest common subsequence: trim them first so the
  // usual near-verbatim case costs linear time instead of a full table.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  if (head + tail > 0) return head + tail + lcsLength(a.slice(head, a.length - tail), b.slice(head, b.length - tail));
  if (!a.length || !b.length) return 0;
  let prev = new Uint32Array(b.length + 1);
  let cur = new Uint32Array(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    const ai = a[i - 1];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = ai === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

export interface VerbatimCheck {
  ok: boolean;
  /** Script tokens missing from the output. */
  missing: number;
  /** Output tokens that are not in the script (in order). */
  extra: number;
  scriptTokens: number;
}

/**
 * Checks that `output` keeps the words of `source` in order. Small tolerances absorb harmless
 * differences (a number written out, a dropped speaker label) without accepting paraphrases. The
 * tolerances are capped so a long script cannot silently lose or gain a whole sentence.
 */
export function checkVerbatim(source: string, output: string): VerbatimCheck {
  const a = normalizedTokens(source);
  const b = normalizedTokens(output);
  const common = lcsLength(a, b);
  const missing = a.length - common;
  const extra = b.length - common;
  const allowedMissing = Math.min(3, Math.max(1, Math.round(a.length * 0.04)));
  const allowedExtra = Math.min(4, Math.max(1, Math.round(b.length * 0.06)));
  return { ok: missing <= allowedMissing && extra <= allowedExtra, missing, extra, scriptTokens: a.length };
}
