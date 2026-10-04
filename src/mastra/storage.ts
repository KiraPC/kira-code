import { resolve } from 'node:path';
import { MastraCompositeStore, MemoryStorage } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { KIRA_HOME } from '../config';

type ThreadPatch = { id: string; title?: string; metadata?: Record<string, unknown> };

/**
 * `MemoryStorage.patchThread`, for a core that predates it.
 *
 * @mastra/memory 1.26.1 persists every observation — `/compact`, the automatic
 * pass at the threshold, buffered activation — through `patchThread`, which
 * core only added to the MemoryStorage base class in 1.58.0. The vendored
 * 1.58.0-alpha.13 does not have it, so the first observation threw "patchThread
 * is not a function" and took the CLI down. Downgrading memory is not an out:
 * 1.26.0 throws on the approval-requested tool calls every gated turn leaves
 * behind. Adapters inherit the method rather than defining it, so it goes on
 * the base class, with the body core 1.58.0 ships, and only when missing: on a
 * core that has it this does nothing.
 */
const memoryPrototype = MemoryStorage.prototype as MemoryStorage & {
  patchThread?: (patch: ThreadPatch) => Promise<unknown>;
  supportsPartialThreadUpdate?: boolean;
};

if (typeof memoryPrototype.patchThread !== 'function') {
  memoryPrototype.patchThread = async function patchThread(this: typeof memoryPrototype, { id, title, metadata }) {
    // Legacy adapters write both columns on update; backfill whatever the
    // caller left out rather than blank the title.
    if (!this.supportsPartialThreadUpdate && (title === undefined || metadata === undefined)) {
      const existing = await this.getThreadById({ threadId: id });
      if (existing) {
        title = title ?? existing.title ?? '';
        metadata = metadata ?? existing.metadata ?? {};
      }
    }

    return this.updateThread({
      id,
      ...(title !== undefined ? { title } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    } as Parameters<MemoryStorage['updateThread']>[0]);
  };
}

/**
 * The DuckDB file behind observability. Kept by reference because the
 * composite store only holds its observability domain, and closing the
 * composite (what `Mastra.shutdown()` does) leaves the DuckDB instance — and
 * its single-writer file lock — open until the process exits.
 */
const observabilityDb = new DuckDBStore({
  // Absolute for the same reason as the LibSQL url below, and so the CLI doesn't
  // drop telemetry files into whatever project it was started from.
  path: resolve(KIRA_HOME, 'mastra.duckdb'),
});

/**
 * Frees the DuckDB lock. DuckDB allows one read-write process per file, so
 * Studio cannot open the traces while the CLI still holds it; `--studio` calls
 * this after shutting the CLI's Mastra instance down, before starting Studio.
 */
export async function releaseObservabilityStore(): Promise<void> {
  await observabilityDb.close();
}

/**
 * One store shared by the Mastra instance and the AgentController, so threads,
 * messages and thread settings are the same whether you drive kira-code from
 * Studio or from the CLI.
 */
export const storage = new MastraCompositeStore({
  id: 'composite-storage',
  default: new LibSQLStore({
    id: 'mastra-storage',
    // Absolute on purpose: `mastra dev` runs the bundled server from a nested
    // directory, so a relative path would give Studio and the CLI two
    // different databases and two different sets of threads.
    url: process.env.TURSO_DATABASE_URL || `file:${resolve(KIRA_HOME, 'mastra.db')}`,
    authToken: process.env.TURSO_AUTH_TOKEN || undefined,
  }),
  domains: {
    observability: await observabilityDb.getStore('observability'),
  },
});
