import { pino, stdSerializers, type Logger, type LoggerOptions } from 'pino';
import type { AppConfig } from './config.js';

/**
 * Paths removed from every log line. Covers request/response headers (Fastify serializers and
 * ad-hoc objects), and any object that happens to carry credentials.
 */
export const REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-goog-api-key"]',
  'res.headers["set-cookie"]',
  'headers.authorization',
  'headers.cookie',
  'headers["set-cookie"]',
  'headers["x-goog-api-key"]',
  'authorization',
  'cookie',
  'apiKey',
  '*.apiKey',
  'GEMINI_API_KEY',
  '*.GEMINI_API_KEY',
  'password',
  '*.password',
  'sessionSecret',
  '*.sessionSecret',
  'apiTokens',
  '*.apiTokens',
  'secretAccessKey',
  '*.secretAccessKey',
];

/** Cloud Logging severities, so JSON logs are classified correctly on Google Cloud. */
const SEVERITY: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

const GOOGLE_KEY_PATTERN = /AIza[0-9A-Za-z_-]{30,}/g;

/** Returns a function that removes configured secrets from free text (error messages, stacks). */
export function createSecretScrubber(config: AppConfig): (text: string) => string {
  const secrets = [
    config.gemini.apiKey,
    config.auth.sessionSecret,
    config.auth.password,
    config.storage.s3.secretAccessKey,
    ...config.auth.apiTokens,
  ].filter((s): s is string => typeof s === 'string' && s.length >= 8);
  return (text: string) => {
    let out = text;
    for (const secret of secrets) out = out.split(secret).join('[REDACTED]');
    return out.replace(GOOGLE_KEY_PATTERN, '[REDACTED]');
  };
}

export function createLogger(config: AppConfig, overrides: Partial<LoggerOptions> = {}): Logger {
  const pretty = config.env === 'development' && Boolean(process.stdout.isTTY);
  const scrub = createSecretScrubber(config);

  const options: LoggerOptions = {
    level: config.logLevel,
    base: { service: 'omni-ugc-studio', role: config.role },
    redact: { paths: REDACT_PATHS, censor: '[REDACTED]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    serializers: {
      // Upstream SDK errors can echo request URLs or headers: scrub secrets from message and stack.
      err: (err: Error) => {
        const out = stdSerializers.err(err) as unknown as Record<string, unknown>;
        if (typeof out.message === 'string') out.message = scrub(out.message);
        if (typeof out.stack === 'string') out.stack = scrub(out.stack);
        return out;
      },
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'SYS:HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {
          formatters: {
            level: (label: string) => ({ level: label, severity: SEVERITY[label] ?? 'DEFAULT' }),
          },
        }),
    ...overrides,
  };
  return pino(options);
}
