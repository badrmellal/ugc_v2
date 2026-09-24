import { describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, type ScriptPlan } from '@shared/api';
import { diffSegmentEdits, planBasisKey, planForSubmit, updateBibleField, updateSegmentField } from './plan';

const plan: ScriptPlan = {
  source: 'llm',
  character: 'Woman in her 30s, green sweater',
  setting: 'Bright kitchen',
  voice: 'Warm, upbeat',
  audio: 'Quiet room tone',
  language: 'en',
  segments: [
    {
      index: 1,
      startSec: 0,
      endSec: 10,
      dialogue: 'Hi there.',
      action: 'Waves',
      camera: 'Selfie',
      onScreenText: '',
      prompt: 'p1',
    },
    {
      index: 2,
      startSec: 10,
      endSec: 20,
      dialogue: 'Bye now.',
      action: 'Smiles',
      camera: 'Selfie',
      onScreenText: '',
      prompt: 'p2',
    },
  ],
  warnings: [],
  estimatedSpokenSeconds: 1.5,
};

describe('plan editing', () => {
  it('marks the plan as user-edited without mutating the original', () => {
    const edited = updateSegmentField(plan, 1, 'dialogue', 'See you soon.');
    expect(edited.source).toBe('user');
    expect(edited.segments[1].dialogue).toBe('See you soon.');
    expect(edited.segments[0]).toBe(plan.segments[0]);
    expect(plan.segments[1].dialogue).toBe('Bye now.');

    const bible = updateBibleField(plan, 'setting', 'Home office');
    expect(bible.setting).toBe('Home office');
    expect(bible.source).toBe('user');
  });
});

describe('planBasisKey', () => {
  it('ignores resolution and surrounding whitespace', () => {
    const a = planBasisKey('Hello world', DEFAULT_SETTINGS);
    expect(planBasisKey('  Hello world ', { ...DEFAULT_SETTINGS, resolution: '4k' })).toBe(a);
  });

  it('changes with the script or prompt-relevant settings', () => {
    const a = planBasisKey('Hello world', DEFAULT_SETTINGS);
    expect(planBasisKey('Hello there', DEFAULT_SETTINGS)).not.toBe(a);
    expect(planBasisKey('Hello world', { ...DEFAULT_SETTINGS, style: 'scientific' })).not.toBe(a);
    expect(planBasisKey('Hello world', { ...DEFAULT_SETTINGS, language: 'fr' })).not.toBe(a);
  });
});

describe('planForSubmit', () => {
  it('sends fresh or edited plans and drops stale untouched ones', () => {
    expect(planForSubmit(null, { stale: false, edited: false })).toBeUndefined();
    expect(planForSubmit(plan, { stale: false, edited: false })).toBe(plan);
    expect(planForSubmit(plan, { stale: true, edited: true })).toBe(plan);
    expect(planForSubmit(plan, { stale: true, edited: false })).toBeUndefined();
  });
});

describe('diffSegmentEdits', () => {
  it('returns only changed fields, compared after trimming', () => {
    const original = plan.segments[1];
    expect(
      diffSegmentEdits(original, { dialogue: 'Bye now. ', action: 'Smiles', camera: 'Slow push in', onScreenText: '' }),
    ).toEqual({ camera: 'Slow push in' });
  });

  it('treats a missing original as empty', () => {
    expect(diffSegmentEdits(null, { dialogue: 'Hi', action: '', camera: '', onScreenText: '' })).toEqual({
      dialogue: 'Hi',
    });
  });
});
