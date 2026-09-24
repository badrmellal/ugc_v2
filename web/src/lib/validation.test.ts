import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, LIMITS } from '@shared/api';
import { validateImageFile } from './image';
import { mergeSettings } from './draft';
import { issueList, validateCreateForm } from './validation';

describe('validateCreateForm', () => {
  it('requires a script and an image', () => {
    const issues = validateCreateForm({ script: 'short', settings: DEFAULT_SETTINGS, hasImage: false });
    expect(issues.script).toBeDefined();
    expect(issues.image).toBeDefined();
    expect(issueList(issues)).toHaveLength(2);
  });

  it('accepts a valid form and checks the language tag', () => {
    const script = 'This is a perfectly fine script for a short video.';
    expect(issueList(validateCreateForm({ script, settings: DEFAULT_SETTINGS, hasImage: true }))).toEqual([]);
    const bad = validateCreateForm({ script, settings: { ...DEFAULT_SETTINGS, language: 'english!' }, hasImage: true });
    expect(bad.language).toBeDefined();
    const ok = validateCreateForm({ script, settings: { ...DEFAULT_SETTINGS, language: 'pt-BR' }, hasImage: true });
    expect(ok.language).toBeUndefined();
    // Same pattern as the server: at most three subtags.
    const long = validateCreateForm({
      script,
      settings: { ...DEFAULT_SETTINGS, language: 'en-Latn-US-x1-y2' },
      hasImage: true,
    });
    expect(long.language).toBeDefined();
  });

  it('applies the server limit to the voice direction and extra directions', () => {
    const script = 'This is a perfectly fine script for a short video.';
    const tooLong = 'a'.repeat(LIMITS.extraDirectionsMaxChars + 1);
    const issues = validateCreateForm({
      script,
      settings: { ...DEFAULT_SETTINGS, voiceHint: tooLong, extraDirections: tooLong },
      hasImage: true,
    });
    expect(issues.voiceHint).toBeDefined();
    expect(issues.extraDirections).toBeDefined();
    // Surrounding whitespace is trimmed by the server before the length check.
    const padded = validateCreateForm({
      script,
      settings: { ...DEFAULT_SETTINGS, voiceHint: ` ${'a'.repeat(LIMITS.voiceHintMaxChars)} ` },
      hasImage: true,
    });
    expect(padded.voiceHint).toBeUndefined();
  });
});

describe('validateImageFile', () => {
  it('accepts supported images within the size limit', () => {
    expect(validateImageFile({ name: 'a.jpg', type: 'image/jpeg', size: 1000 })).toBeNull();
    expect(validateImageFile({ name: 'a.webp', type: '', size: 1000 })).toBeNull();
    expect(validateImageFile({ name: 'a.PNG', type: 'application/octet-stream', size: 1000 })).toBeNull();
  });

  it('rejects other types, empty and oversized files', () => {
    expect(validateImageFile({ name: 'a.gif', type: 'image/gif', size: 1000 })).toMatch(/JPEG, PNG or WebP/);
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: 0 })).toMatch(/empty/);
    expect(validateImageFile({ name: 'a.png', type: 'image/png', size: LIMITS.imageMaxBytes + 1 })).toMatch(
      /maximum is 10 MB/,
    );
  });
});

describe('mergeSettings', () => {
  it('keeps valid stored values and ignores malformed ones', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, {
      style: 'scientific',
      resolution: '8k',
      imageMode: 'first_frame',
      language: 42,
      reinforceCharacterOnExtend: true,
    });
    expect(merged).toEqual({
      ...DEFAULT_SETTINGS,
      style: 'scientific',
      imageMode: 'first_frame',
      reinforceCharacterOnExtend: true,
    });
  });
});
