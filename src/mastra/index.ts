import { Mastra } from '@mastra/core/mastra';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { exploreAgent } from './agents/explore-agent';
import { kiraCode } from './agents/kira-code';
import { controller } from './controller';
import { storage } from './storage';

export const mastra = new Mastra({
  bundler: {
    externals: ['@duckdb/node-bindings'],
  },
  agents: { kiraCode, exploreAgent },
  agentControllers: { controller },
  storage,
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
