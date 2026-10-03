import { resolve } from 'node:path';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { LibSQLStore } from '@mastra/libsql';
import { KIRA_HOME } from './config';

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
    // Absolute for the same reason as above, and so the CLI doesn't drop
    // telemetry files into whatever project it was started from.
    observability: await new DuckDBStore({
      path: resolve(KIRA_HOME, 'mastra.duckdb'),
    }).getStore('observability'),
  },
});
