/**
 * Environment setup for the CLI, which — unlike `mastra dev` — can be started
 * from any directory.
 *
 * This module must be imported *first* by the CLI: ES module imports run in
 * order, and everything downstream reads `process.env` while it initializes.
 *
 * It settles three things:
 * 1. `KIRA_HOME` — where kira-code itself lives (its skills and database),
 *    derived from this file's own location rather than the cwd.
 * 2. `.env` — loaded from that home, so the API keys are found no matter
 *    where you launched from.
 * 3. `KIRA_PROJECT_DIR` — the project to work on, which defaults to the
 *    directory you started the CLI in.
 */
import { statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const KIRA_HOME = resolve(dirname(fileURLToPath(import.meta.url)), '..');

process.env.KIRA_HOME ??= KIRA_HOME;

const envFile = resolve(KIRA_HOME, '.env');
if (statSync(envFile, { throwIfNoEntry: false })?.isFile()) {
  try {
    process.loadEnvFile(envFile);
  } catch (error) {
    console.warn(`Could not load ${envFile}: ${error instanceof Error ? error.message : error}`);
  }
}

// An explicit KIRA_PROJECT_DIR still wins; this is only the default.
if (!process.env.KIRA_PROJECT_DIR?.trim()) {
  process.env.KIRA_PROJECT_DIR = process.cwd();
}
