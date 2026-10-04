import { Mastra } from '@mastra/core/mastra';
import {
  MastraStorageExporter,
  MastraPlatformExporter,
  Observability,
  SensitiveDataFilter,
} from '@mastra/observability';
import { exploreAgent } from './agent/explore';
import { kiraCode } from './agent/kira-code';
import { controller } from './controller/index';
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
