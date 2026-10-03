/**
 * Prints a thread's full context list: every message in order, its role, its
 * parts, and — for state signals — the lane, mode and version.
 *
 * Used to verify that the session-context signal is emitted once per change
 * rather than once per turn.
 *
 *   node scripts/dump-context.mjs <threadId>
 */
import { createClient } from '@libsql/client';

const [threadId] = process.argv.slice(2);
const db = createClient({ url: 'file:/home/paseo/workspace/kira-code/mastra.db' });
const t = await db.execute({
  sql: 'select content, role from mastra_messages where thread_id = ? order by createdAt',
  args: [threadId],
});

console.log(`CONTEXT LIST — ${t.rows.length} messaggi\n`);
let index = 0;
let sessionSignals = 0;
const keys = [];

for (const row of t.rows) {
  let c;
  try { c = JSON.parse(row.content); } catch { continue; }
  const parts = c.parts || [];
  const kinds = parts.map(p => p.type).join(',');
  const text = parts.filter(p => p.type === 'text').map(p => p.text).join(' ').replace(/\n/g, ' ');
  const sig = c.metadata?.signal ?? parts.map(p => p.providerMetadata?.signal).find(Boolean);
  const state = sig?.metadata?.state;
  const isSession = text.startsWith('# Session context');
  if (isSession) { sessionSignals++; keys.push(state?.cacheKey ?? '(nessuna)'); }

  console.log(
    `${String(index++).padStart(2)} ${String(row.role).padEnd(9)} | ${kinds.padEnd(15)} | ` +
    `${(state ? `state:${state.id}/${state.mode} v${state.version}` : sig ? `signal:${sig.type}` : '').padEnd(28)} | ` +
    `${isSession ? '>>> SESSION CONTEXT <<< ' : ''}${text.slice(0, 58)}`,
  );
}

console.log(`\nmessaggi "# Session context": ${sessionSignals}`);
for (const k of keys) console.log('  cacheKey:', k);
