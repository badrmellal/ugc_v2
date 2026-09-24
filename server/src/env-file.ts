import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

/**
 * Loads the nearest `.env` (current directory, then up to two parents: `npm start` runs inside
 * `server/` while `.env` lives at the repository root). Variables already set in the environment win,
 * so containers and cloud platforms are unaffected. Returns the loaded path, or null.
 */
export function loadDotEnv(startDir: string = process.cwd()): string | null {
  let dir = resolve(startDir);
  for (let i = 0; i < 3; i += 1) {
    const candidate = join(dir, '.env');
    if (existsSync(candidate)) {
      process.loadEnvFile(candidate);
      return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
