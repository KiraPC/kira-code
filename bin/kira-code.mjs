#!/usr/bin/env node
/**
 * Launcher so kira-code can be started from the project you want it to work on.
 *
 * `npm run cli` always runs with the package root as the working directory,
 * which would pin the agent to kira-code itself. This wrapper resolves tsx and
 * the CLI entry point from the package, and inherits the caller's cwd — that
 * cwd is what the CLI uses as the project directory.
 */
import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tsx = resolve(packageRoot, 'node_modules', '.bin', 'tsx');
const entry = resolve(packageRoot, 'src', 'cli.ts');

const child = spawn(tsx, [entry, ...process.argv.slice(2)], { stdio: 'inherit' });

child.on('error', error => {
  console.error(`Could not start kira-code: ${error.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
