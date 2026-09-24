/** Display formatters. Pure functions, safe to unit test. */

const usd2 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
const usd4 = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const integer = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

/** `$1.40`, `$0.35`; amounts under 10 cents keep up to 4 decimals (`$0.0042`). */
export function formatUsd(amount: number): string {
  if (!Number.isFinite(amount)) return '-';
  const abs = Math.abs(amount);
  return abs > 0 && abs < 0.1 ? usd4.format(amount) : usd2.format(amount);
}

export function formatInteger(value: number): string {
  return Number.isFinite(value) ? integer.format(value) : '-';
}

/** Human duration: `45s`, `1m 15s`, `2m`, `1h 5m`. */
export function formatDuration(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '-';
  const s = Math.round(totalSeconds);
  if (s < 60) return `${s}s`;
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return seconds === 0 ? `${minutes}m` : `${minutes}m ${seconds}s`;
}

/** Video length with one decimal when needed: `20s`, `19.9s`. */
export function formatVideoLength(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '-';
  const rounded = Math.round(seconds * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}s` : `${rounded.toFixed(1)}s`;
}

/** Clock-style offset used in the event log: `0:07`, `2:15`, `1:02:03`. */
export function formatClock(totalSeconds: number): string {
  if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
  const s = Math.floor(totalSeconds);
  const hours = Math.floor(s / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = String(s % 60).padStart(2, '0');
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`;
  return `${minutes}:${seconds}`;
}

/** `512 B`, `1.5 KB`, `10 MB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '-';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const rounded = Math.round(value * 10) / 10;
  const text = rounded >= 10 || Number.isInteger(rounded) ? String(Math.round(rounded)) : rounded.toFixed(1);
  return `${text} ${units[unit]}`;
}

export function formatPercent(value: number): string {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(Math.min(100, Math.max(0, value)))}%`;
}

function toTime(value: string | number | Date): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'number') return value;
  return new Date(value).getTime();
}

const relative = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** `just now`, `5 minutes ago`, `yesterday`, then a short date after a week. */
export function formatRelativeTime(value: string | number | Date, now: number = Date.now()): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return '-';
  const diffSeconds = Math.round((time - now) / 1000);
  const abs = Math.abs(diffSeconds);
  if (abs < 45) return 'just now';
  if (abs < 45 * 60) return relative.format(Math.round(diffSeconds / 60), 'minute');
  if (abs < 22 * 3600) return relative.format(Math.round(diffSeconds / 3600), 'hour');
  if (abs < 7 * 86400) return relative.format(Math.round(diffSeconds / 86400), 'day');
  return formatDate(time);
}

export function formatDate(value: string | number | Date): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(time);
}

export function formatDateTime(value: string | number | Date): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return '-';
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium' }).format(time);
}

export function formatTime(value: string | number | Date): string {
  const time = toTime(value);
  if (!Number.isFinite(time)) return '-';
  return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(time);
}

/** Seconds between two timestamps (end defaults to now), never negative. */
export function secondsBetween(start: string | number | Date, end: string | number | Date | null = null): number {
  const from = toTime(start);
  const to = end === null ? Date.now() : toTime(end);
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0;
  return Math.max(0, (to - from) / 1000);
}
