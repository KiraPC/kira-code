import { spawn } from 'node:child_process';
import { KIRA_HOME } from '../config';
import { releaseObservabilityStore } from '../mastra/storage';
import { color } from './ui/color';

/**
 * `--studio`: once the session is over, hand the terminal to Mastra Studio so
 * the traces of the run just done can be shown.
 *
 * Not alongside the CLI, because it cannot be: observability lives in DuckDB,
 * which takes a single-writer lock on the file. Measured both ways — with the
 * CLI running, `mastra dev` fails to open mastra.duckdb and its server exits;
 * with Studio running, the CLI fails at startup. So Studio starts only after
 * the CLI has shut Mastra down and released that lock.
 */
export const studioRequested = process.argv.slice(2).includes('--studio');

const STUDIO_URL = 'http://localhost:4111';

/** Runs `npm run dev` in the foreground until it exits; resolves with its exit code. */
export async function runStudio(): Promise<number> {
  await releaseObservabilityStore();

  console.log(color.dim(`\nStudio: ${STUDIO_URL} — traces under Observability. Ctrl-C to stop.\n`));

  const child = spawn('npm', ['run', 'dev'], { cwd: KIRA_HOME, env: process.env, stdio: 'inherit' });

  // Ctrl-C reaches the whole foreground process group, Studio included. This
  // process only has to outlive it: exiting first would return the prompt while
  // the server is still shutting down, and leave it orphaned on 4111.
  const ignoreInterrupt = () => {};
  process.on('SIGINT', ignoreInterrupt);
  process.on('SIGTERM', () => child.kill('SIGTERM'));

  return new Promise(resolve => {
    child.on('exit', code => {
      process.off('SIGINT', ignoreInterrupt);
      resolve(code ?? 0);
    });
    child.on('error', error => {
      console.error(color.red(`could not start Studio: ${error.message}`));
      resolve(1);
    });
  });
}
