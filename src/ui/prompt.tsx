import { Box, Text } from 'ink';
import React from 'react';
import type { UiState } from './store.js';

/**
 * The prompt: what has been typed, where the caret is, and what could complete
 * it.
 *
 * Ink hides the terminal's own cursor, so one is drawn here — the first version
 * of this screen had none, and typing into a line with no caret feels broken
 * even when it works.
 */
export function Prompt({ state }: { state: UiState }): React.ReactElement {
  const { input, cursor } = state;

  const before = input.slice(0, cursor);
  const at = input.slice(cursor, cursor + 1) || ' ';
  const after = input.slice(cursor + 1);

  // A pasted block is shown as its first line plus a count: twenty lines of
  // input would otherwise push everything else off the screen before it is sent.
  const lines = input.split('\n');
  const multiline = lines.length > 1;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color="green">{state.prompt}</Text>
        {multiline ? (
          <Text>
            {lines[0]}
            <Text dimColor>{` … +${lines.length - 1} lines`}</Text>
          </Text>
        ) : (
          <Text>
            {before}
            <Text inverse>{at}</Text>
            {after}
          </Text>
        )}
      </Box>

      {state.completions.length > 0 ? (
        <Box flexDirection="column">
          {state.completions.slice(0, 8).map(completion => (
            <Text key={completion} dimColor>
              {`  ${completion}`}
            </Text>
          ))}
        </Box>
      ) : null}
    </Box>
  );
}
