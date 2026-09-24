import { describe, expect, it } from 'vitest';
import type { GenerationEvent } from '@shared/api';
import { computeSteps } from './stages';

const states = (steps: ReturnType<typeof computeSteps>) => steps.map((step) => step.state);
const event = (stage: GenerationEvent['stage']): GenerationEvent => ({
  at: '2026-09-24T12:00:00Z',
  stage,
  level: 'info',
  message: stage,
});

describe('computeSteps', () => {
  it('marks everything pending while queued', () => {
    expect(states(computeSteps({ status: 'queued', stage: 'queued', events: [] }))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });

  it('marks earlier stages done and the current one active while running', () => {
    expect(states(computeSteps({ status: 'running', stage: 'generating_part1', events: [] }))).toEqual([
      'done',
      'done',
      'active',
      'pending',
      'pending',
    ]);
  });

  it('marks everything done on success', () => {
    expect(states(computeSteps({ status: 'succeeded', stage: 'completed', events: [] }))).toEqual([
      'done',
      'done',
      'done',
      'done',
      'done',
    ]);
  });

  it('uses the event log to find where a failed job stopped', () => {
    const events = [event('planning'), event('uploading_image'), event('generating_part1'), event('extending_part2')];
    expect(states(computeSteps({ status: 'failed', stage: 'failed', events }))).toEqual([
      'done',
      'done',
      'done',
      'failed',
      'pending',
    ]);
  });

  it('marks the stopping point of a canceled job', () => {
    const events = [event('planning'), event('uploading_image')];
    expect(states(computeSteps({ status: 'canceled', stage: 'canceled', events }))).toEqual([
      'done',
      'canceled',
      'pending',
      'pending',
      'pending',
    ]);
    expect(states(computeSteps({ status: 'canceled', stage: 'canceled', events: [] }))).toEqual([
      'pending',
      'pending',
      'pending',
      'pending',
      'pending',
    ]);
  });
});
