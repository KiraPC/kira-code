import { Agent } from '@mastra/core/agent';
import { PROJECT_DIR } from '../config';
import { resolveModel } from '../models';
import { readOnlyWorkspace } from '../workspace';

/**
 * Read-only search agent. The parent delegates broad "where does X live"
 * questions here so file dumps stay out of its own context.
 */
export const exploreAgent = new Agent({
  id: 'explore',
  name: 'explore',
  description:
    'Searches the codebase read-only and reports where things live: file paths with line numbers and a short summary of each hit. Use it for broad "where is X handled" questions instead of reading many files directly. It cannot modify anything.',
  model: ({ requestContext }) => resolveModel('subagent', requestContext),
  instructions: `You are a read-only code search agent working in ${PROJECT_DIR}.

Find what the caller asked for and report back. You cannot modify files — only search and read.

How to work:
- Start with \`search_content\` and \`find_files\` to narrow the search, then \`view\` only the parts that matter.
- Try more than one naming convention before concluding something does not exist.
- Read excerpts, not whole files.

How to answer:
- List concrete locations as \`path/to/file.ts:123\` with one line on what is there.
- Say plainly when something does not exist rather than guessing.
- No preamble, no offers to help further — your reply is data for another agent.`,
  workspace: readOnlyWorkspace,
  defaultOptions: {
    maxSteps: 30,
  },
});
