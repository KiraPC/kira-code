/**
 * Clears the stored working memory of every project.
 *
 * Changing the template in `mastra/memory.ts` does not touch what is already
 * saved: the old document keeps being sent as `<working_memory_data>` until the
 * agent happens to rewrite it, so a stale user profile would outlive the change
 * that was meant to remove it. This wipes the documents so the next write starts
 * from the current template.
 *
 * Destructive, and deliberately manual — it drops working memory for every
 * project on this machine, not just the current one.
 *
 *   npx tsx scripts/reset-working-memory.ts          # show what would be cleared
 *   npx tsx scripts/reset-working-memory.ts --yes    # clear it
 */
import '../src/cli-bootstrap';
import { memory } from '../src/mastra/memory/index';

const confirmed = process.argv.includes('--yes');

const store = await memory.storage.getStore('memory');
if (!store) {
  console.error('no memory store configured');
  process.exit(1);
}

const resources = store as unknown as {
  getResourceById(args: { resourceId: string }): Promise<{ workingMemory?: string | null } | null>;
  updateResource(args: { resourceId: string; workingMemory?: string | null }): Promise<unknown>;
};

// The store has no "list every resource" call, so the ids come from the threads
// table: a resource without a thread has no working memory to clear either.
const { createClient } = await import('@libsql/client');
const { KIRA_HOME } = await import('../src/config');
const db = createClient({ url: `file:${KIRA_HOME}/mastra.db` });

const rows = await db.execute('select distinct "resourceId" from mastra_threads where "resourceId" is not null');
const resourceIds = rows.rows.map(row => String(row.resourceId));

let cleared = 0;

for (const resourceId of resourceIds) {
  const resource = await resources.getResourceById({ resourceId });
  const current = resource?.workingMemory?.trim();
  if (!current) continue;

  const firstLine = current.split('\n')[0] ?? '';
  console.log(`${confirmed ? 'clearing' : 'would clear'}  ${resourceId}  (${current.length} chars, "${firstLine}")`);

  if (confirmed) {
    await resources.updateResource({ resourceId, workingMemory: null });
    cleared += 1;
  }
}

if (resourceIds.length === 0) console.log('no resources found');
else if (!confirmed) console.log('\nnothing changed — re-run with --yes to clear');
else console.log(`\ncleared ${cleared} document(s)`);

process.exit(0);
