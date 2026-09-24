import { z } from 'zod';
import type { PricingInfo, Resolution } from './shared/api.js';

const bool = (defaultValue: boolean) =>
  z
    .string()
    .optional()
    .transform((v) => {
      if (v === undefined || v.trim() === '') return defaultValue;
      return ['1', 'true', 'yes', 'on'].includes(v.trim().toLowerCase());
    });

const optionalNumber = z
  .string()
  .optional()
  .transform((v, ctx) => {
    if (v === undefined || v.trim() === '') return null;
    const n = Number(v);
    if (!Number.isFinite(n)) {
      ctx.addIssue({ code: 'custom', message: `expected a number, got "${v}"` });
      return z.NEVER;
    }
    return n;
  });

const numberWithDefault = (defaultValue: number) => optionalNumber.transform((v) => (v === null ? defaultValue : v));

const csv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: numberWithDefault(8080),
  HOST: z.string().default('0.0.0.0'),
  /** `all` runs API + worker in one process, `web` only the API, `worker` only the job runner. */
  ROLE: z.enum(['all', 'web', 'worker']).default('all'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  /** Public origin of the app (e.g. https://ugc.example.com). Used for Origin checks on mutating requests. */
  PUBLIC_ORIGIN: z.string().optional(),
  TRUST_PROXY: bool(true),

  // --- Gemini ---
  GEMINI_API_KEY: z.string().optional(),
  /** Run without calling Google: videos are synthesized locally with ffmpeg. For demos and tests. */
  GEMINI_MOCK: bool(false),
  OMNI_MODEL: z.string().default('gemini-omni-1.1-flash'),
  SPLITTER_MODEL: z.string().default('gemini-3.8-flash'),
  /** Per-HTTP-request timeout for Gemini calls, in seconds. */
  GEMINI_REQUEST_TIMEOUT_SEC: numberWithDefault(900),
  /** Give up on a single video turn after this many seconds. */
  GEMINI_TURN_TIMEOUT_SEC: numberWithDefault(1500),
  GEMINI_POLL_INTERVAL_SEC: numberWithDefault(8),
  /** Mock mode only: simulated latency per turn and whether the extension returns the full 20s. */
  MOCK_TURN_SECONDS: numberWithDefault(6),
  MOCK_EXTENSION_RETURNS_FULL: bool(true),

  // --- Database ---
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/omni_ugc'),
  DATABASE_SSL: bool(false),
  DATABASE_POOL_MAX: numberWithDefault(10),
  MIGRATE_ON_START: bool(true),

  // --- Storage ---
  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./data/storage'),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('auto'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: bool(false),
  S3_PREFIX: z.string().default(''),
  /** Serve videos through short-lived presigned URLs (S3 only). Otherwise stream through the API. */
  S3_PRESIGNED_URLS: bool(true),
  S3_PRESIGN_TTL_SEC: numberWithDefault(3600),

  // --- Auth & security ---
  /** Shared password for the web UI. When empty and NODE_ENV=production the server refuses to start. */
  APP_PASSWORD: z.string().optional(),
  /** Explicitly allow running without authentication (e.g. behind an identity-aware proxy). */
  AUTH_DISABLED: bool(false),
  /** Secret used to sign session cookies. Min 32 chars. */
  SESSION_SECRET: z.string().optional(),
  SESSION_TTL_HOURS: numberWithDefault(24 * 7),
  /** Comma-separated bearer tokens for programmatic API access. */
  API_TOKENS: csv,
  RATE_LIMIT_PER_MINUTE: numberWithDefault(120),
  CREATE_RATE_LIMIT_PER_HOUR: numberWithDefault(30),

  // --- Worker & budget ---
  WORKER_CONCURRENCY: numberWithDefault(2),
  WORKER_POLL_INTERVAL_MS: numberWithDefault(2000),
  JOB_LEASE_SEC: numberWithDefault(120),
  JOB_MAX_ATTEMPTS: numberWithDefault(3),
  /** Hard cap on USD spend per UTC day (estimates of in-flight jobs count). Empty = unlimited. */
  DAILY_BUDGET_USD: optionalNumber,
  MAX_QUEUED_JOBS: numberWithDefault(20),

  // --- Pricing (USD). Defaults follow Google's published Gemini API list prices; override when they change. ---
  PRICE_VIDEO_OUTPUT_PER_M_TOKENS: numberWithDefault(17.5),
  PRICE_INPUT_PER_M_TOKENS: numberWithDefault(1.5),
  PRICE_TEXT_OUTPUT_PER_M_TOKENS: numberWithDefault(9),
  /**
   * Video output tokens per generated second, by resolution. 720p (5,792/s) is Google's published rate;
   * 360p is measured (~1/3 of 720p); 1080p and 4k are upscaled and not officially published, so the
   * defaults are conservative. Actual cost is always recomputed from reported token usage.
   */
  VIDEO_TOKENS_PER_SEC_360P: numberWithDefault(1931),
  VIDEO_TOKENS_PER_SEC_720P: numberWithDefault(5792),
  VIDEO_TOKENS_PER_SEC_1080P: numberWithDefault(8688),
  VIDEO_TOKENS_PER_SEC_4K: numberWithDefault(17376),
  /** Input tokens per second of prior video carried as context into the extension turn (conservative). */
  VIDEO_INPUT_TOKENS_PER_SEC: numberWithDefault(5792),
  IMAGE_INPUT_TOKENS: numberWithDefault(1120),
  /** Text + thinking tokens Omni spends per turn rewriting the prompt (billed at the text output rate). */
  TURN_TEXT_OUTPUT_TOKENS: numberWithDefault(1100),
  SPLITTER_PRICE_PER_CALL_USD: numberWithDefault(0.002),
  /**
   * Whether the extension turn bills video output tokens for only the new 10s (observed in usage-backed
   * cost ledgers, with the prior clip billed as input context) or for the whole returned 20s clip.
   */
  EXTENSION_BILLING: z.enum(['new_seconds', 'full_output']).default('new_seconds'),
  PRICING_SOURCE: z.string().default('Gemini API pricing for gemini-omni-1.1-flash (override via PRICE_* env vars)'),

  WEB_DIST_DIR: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export interface AppConfig {
  env: Env['NODE_ENV'];
  isProduction: boolean;
  port: number;
  host: string;
  role: Env['ROLE'];
  logLevel: Env['LOG_LEVEL'];
  publicOrigin: string | null;
  trustProxy: boolean;
  gemini: {
    apiKey: string | null;
    mock: boolean;
    videoModel: string;
    splitterModel: string;
    requestTimeoutMs: number;
    turnTimeoutMs: number;
    pollIntervalMs: number;
    mockTurnSeconds: number;
    mockExtensionReturnsFull: boolean;
  };
  db: { url: string; ssl: boolean; poolMax: number; migrateOnStart: boolean };
  storage: {
    driver: 'local' | 's3';
    localDir: string;
    s3: {
      bucket: string | null;
      region: string;
      endpoint: string | null;
      accessKeyId: string | null;
      secretAccessKey: string | null;
      forcePathStyle: boolean;
      prefix: string;
      presignedUrls: boolean;
      presignTtlSec: number;
    };
  };
  auth: {
    password: string | null;
    disabled: boolean;
    sessionSecret: string;
    sessionTtlMs: number;
    apiTokens: string[];
  };
  rateLimit: { perMinute: number; createPerHour: number };
  worker: {
    concurrency: number;
    pollIntervalMs: number;
    leaseMs: number;
    maxAttempts: number;
    maxQueuedJobs: number;
  };
  budget: { dailyUsd: number | null };
  pricing: PricingInfo & {
    videoTokensPerSecond: Record<Resolution, number>;
    videoInputTokensPerSecond: number;
    imageInputTokens: number;
    turnTextOutputTokens: number;
  };
  webDistDir: string | null;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = EnvSchema.safeParse(source);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new ConfigError(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const isProduction = e.NODE_ENV === 'production';

  const apiKey = e.GEMINI_API_KEY?.trim() || null;
  if (!e.GEMINI_MOCK && !apiKey) {
    throw new ConfigError('GEMINI_API_KEY is required (or set GEMINI_MOCK=true to run with synthetic videos).');
  }
  if (isProduction && e.GEMINI_MOCK) {
    // Allowed, but loud: mock mode never calls Google.
    process.emitWarning('GEMINI_MOCK=true in production: no real videos will be generated.');
  }

  const password = e.APP_PASSWORD?.trim() || null;
  // The worker serves no user-facing API, so auth settings only matter for the web roles.
  const servesApi = e.ROLE !== 'worker';
  if (servesApi && isProduction && !password && !e.AUTH_DISABLED && e.API_TOKENS.length === 0) {
    throw new ConfigError(
      'Set APP_PASSWORD (and SESSION_SECRET) or API_TOKENS in production, or AUTH_DISABLED=true if an upstream proxy authenticates users.',
    );
  }

  let sessionSecret = e.SESSION_SECRET?.trim() || '';
  if (sessionSecret && sessionSecret.length < 32) {
    throw new ConfigError('SESSION_SECRET must be at least 32 characters.');
  }
  if (!sessionSecret) {
    if (servesApi && isProduction && password) {
      throw new ConfigError('SESSION_SECRET is required in production when APP_PASSWORD is set.');
    }
    // Development only: an ephemeral secret (sessions reset on restart).
    sessionSecret = randomSecret();
  }

  if (e.STORAGE_DRIVER === 's3' && !e.S3_BUCKET) {
    throw new ConfigError('S3_BUCKET is required when STORAGE_DRIVER=s3.');
  }

  const positive = (name: string, v: number) => {
    if (!(v > 0)) throw new ConfigError(`${name} must be > 0`);
    return v;
  };

  return {
    env: e.NODE_ENV,
    isProduction,
    port: e.PORT,
    host: e.HOST,
    role: e.ROLE,
    logLevel: e.LOG_LEVEL,
    publicOrigin: e.PUBLIC_ORIGIN?.replace(/\/+$/, '') || null,
    trustProxy: e.TRUST_PROXY,
    gemini: {
      apiKey,
      mock: e.GEMINI_MOCK,
      videoModel: e.OMNI_MODEL,
      splitterModel: e.SPLITTER_MODEL,
      requestTimeoutMs: positive('GEMINI_REQUEST_TIMEOUT_SEC', e.GEMINI_REQUEST_TIMEOUT_SEC) * 1000,
      turnTimeoutMs: positive('GEMINI_TURN_TIMEOUT_SEC', e.GEMINI_TURN_TIMEOUT_SEC) * 1000,
      pollIntervalMs: positive('GEMINI_POLL_INTERVAL_SEC', e.GEMINI_POLL_INTERVAL_SEC) * 1000,
      mockTurnSeconds: Math.max(0, e.MOCK_TURN_SECONDS),
      mockExtensionReturnsFull: e.MOCK_EXTENSION_RETURNS_FULL,
    },
    db: {
      url: e.DATABASE_URL,
      ssl: e.DATABASE_SSL,
      poolMax: positive('DATABASE_POOL_MAX', e.DATABASE_POOL_MAX),
      migrateOnStart: e.MIGRATE_ON_START,
    },
    storage: {
      driver: e.STORAGE_DRIVER,
      localDir: e.LOCAL_STORAGE_DIR,
      s3: {
        bucket: e.S3_BUCKET ?? null,
        region: e.S3_REGION,
        endpoint: e.S3_ENDPOINT ?? null,
        accessKeyId: e.S3_ACCESS_KEY_ID ?? null,
        secretAccessKey: e.S3_SECRET_ACCESS_KEY ?? null,
        forcePathStyle: e.S3_FORCE_PATH_STYLE,
        prefix: e.S3_PREFIX.replace(/^\/+|\/+$/g, ''),
        presignedUrls: e.S3_PRESIGNED_URLS,
        presignTtlSec: positive('S3_PRESIGN_TTL_SEC', e.S3_PRESIGN_TTL_SEC),
      },
    },
    auth: {
      password,
      disabled: e.AUTH_DISABLED,
      sessionSecret,
      sessionTtlMs: positive('SESSION_TTL_HOURS', e.SESSION_TTL_HOURS) * 3600 * 1000,
      apiTokens: e.API_TOKENS,
    },
    rateLimit: {
      perMinute: positive('RATE_LIMIT_PER_MINUTE', e.RATE_LIMIT_PER_MINUTE),
      createPerHour: positive('CREATE_RATE_LIMIT_PER_HOUR', e.CREATE_RATE_LIMIT_PER_HOUR),
    },
    worker: {
      concurrency: Math.max(1, Math.floor(e.WORKER_CONCURRENCY)),
      pollIntervalMs: positive('WORKER_POLL_INTERVAL_MS', e.WORKER_POLL_INTERVAL_MS),
      leaseMs: positive('JOB_LEASE_SEC', e.JOB_LEASE_SEC) * 1000,
      maxAttempts: Math.max(1, Math.floor(e.JOB_MAX_ATTEMPTS)),
      maxQueuedJobs: Math.max(1, Math.floor(e.MAX_QUEUED_JOBS)),
    },
    budget: { dailyUsd: e.DAILY_BUDGET_USD },
    pricing: {
      videoOutputUsdPerMillionTokens: e.PRICE_VIDEO_OUTPUT_PER_M_TOKENS,
      inputUsdPerMillionTokens: e.PRICE_INPUT_PER_M_TOKENS,
      textOutputUsdPerMillionTokens: e.PRICE_TEXT_OUTPUT_PER_M_TOKENS,
      splitterUsdPerCallEstimate: e.SPLITTER_PRICE_PER_CALL_USD,
      extensionBilling: e.EXTENSION_BILLING,
      source: e.PRICING_SOURCE,
      videoTokensPerSecond: {
        '360p': e.VIDEO_TOKENS_PER_SEC_360P,
        '720p': e.VIDEO_TOKENS_PER_SEC_720P,
        '1080p': e.VIDEO_TOKENS_PER_SEC_1080P,
        '4k': e.VIDEO_TOKENS_PER_SEC_4K,
      },
      videoOutputUsdPerSecond: {
        '360p': round6((e.VIDEO_TOKENS_PER_SEC_360P * e.PRICE_VIDEO_OUTPUT_PER_M_TOKENS) / 1e6),
        '720p': round6((e.VIDEO_TOKENS_PER_SEC_720P * e.PRICE_VIDEO_OUTPUT_PER_M_TOKENS) / 1e6),
        '1080p': round6((e.VIDEO_TOKENS_PER_SEC_1080P * e.PRICE_VIDEO_OUTPUT_PER_M_TOKENS) / 1e6),
        '4k': round6((e.VIDEO_TOKENS_PER_SEC_4K * e.PRICE_VIDEO_OUTPUT_PER_M_TOKENS) / 1e6),
      },
      videoInputTokensPerSecond: e.VIDEO_INPUT_TOKENS_PER_SEC,
      imageInputTokens: e.IMAGE_INPUT_TOKENS,
      turnTextOutputTokens: e.TURN_TEXT_OUTPUT_TOKENS,
    },
    webDistDir: e.WEB_DIST_DIR ?? null,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

function randomSecret(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString('base64url');
}
