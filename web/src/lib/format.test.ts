import { describe, expect, it } from 'vitest';
import {
  formatBytes,
  formatClock,
  formatDuration,
  formatPercent,
  formatRelativeTime,
  formatUsd,
  formatVideoLength,
  secondsBetween,
} from './format';

describe('formatUsd', () => {
  it('uses two decimals for regular amounts', () => {
    expect(formatUsd(1.4)).toBe('$1.40');
    expect(formatUsd(0.35)).toBe('$0.35');
    expect(formatUsd(12.345)).toBe('$12.35');
    expect(formatUsd(0)).toBe('$0.00');
  });

  it('keeps up to four decimals for amounts under 10 cents', () => {
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(0.002)).toBe('$0.002');
    expect(formatUsd(0.05)).toBe('$0.05');
  });

  it('handles non-finite values', () => {
    expect(formatUsd(Number.NaN)).toBe('-');
  });
});

describe('formatDuration', () => {
  it('formats seconds, minutes and hours', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45.4)).toBe('45s');
    expect(formatDuration(60)).toBe('1m');
    expect(formatDuration(75)).toBe('1m 15s');
    expect(formatDuration(3900)).toBe('1h 5m');
  });

  it('rejects invalid input', () => {
    expect(formatDuration(-1)).toBe('-');
    expect(formatDuration(Number.POSITIVE_INFINITY)).toBe('-');
  });
});

describe('formatVideoLength', () => {
  it('drops the decimal for whole seconds', () => {
    expect(formatVideoLength(20)).toBe('20s');
    expect(formatVideoLength(20.02)).toBe('20s');
    expect(formatVideoLength(19.94)).toBe('19.9s');
    expect(formatVideoLength(null)).toBe('-');
  });
});

describe('formatClock', () => {
  it('pads seconds and adds hours when needed', () => {
    expect(formatClock(7)).toBe('0:07');
    expect(formatClock(135)).toBe('2:15');
    expect(formatClock(3723)).toBe('1:02:03');
    expect(formatClock(-5)).toBe('0:00');
  });
});

describe('formatBytes', () => {
  it('picks a readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(12.4 * 1024 * 1024)).toBe('12 MB');
    expect(formatBytes(2.25 * 1024 * 1024)).toBe('2.3 MB');
  });
});

describe('formatPercent', () => {
  it('clamps and rounds', () => {
    expect(formatPercent(42.6)).toBe('43%');
    expect(formatPercent(140)).toBe('100%');
    expect(formatPercent(-3)).toBe('0%');
  });
});

describe('formatRelativeTime', () => {
  const now = Date.parse('2026-09-24T12:00:00Z');

  it('describes recent times', () => {
    expect(formatRelativeTime('2026-09-24T11:59:40Z', now)).toBe('just now');
    expect(formatRelativeTime('2026-09-24T11:55:00Z', now)).toBe('5 minutes ago');
    expect(formatRelativeTime('2026-09-24T09:00:00Z', now)).toBe('3 hours ago');
    expect(formatRelativeTime('2026-09-23T10:00:00Z', now)).toBe('yesterday');
  });

  it('falls back to a date after a week', () => {
    expect(formatRelativeTime('2026-08-01T10:00:00Z', now)).not.toMatch(/ago/);
  });

  it('handles invalid dates', () => {
    expect(formatRelativeTime('not a date', now)).toBe('-');
  });
});

describe('secondsBetween', () => {
  it('never returns negative values', () => {
    expect(secondsBetween('2026-09-24T12:00:00Z', '2026-09-24T12:01:30Z')).toBe(90);
    expect(secondsBetween('2026-09-24T12:01:30Z', '2026-09-24T12:00:00Z')).toBe(0);
  });
});
