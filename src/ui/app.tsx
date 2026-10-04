import { Box, Static, Text, useApp, useInput } from 'ink';
import React, { useSyncExternalStore } from 'react';
import { PROJECT_DIR } from '../mastra/config.js';
import { Footer } from './footer.js';
import { completeCommand, completePath, interpret, tokenAt } from './input.js';
import { Prompt } from './prompt.js';
import { Tasks } from './tasks.js';
import type { UiStore } from './store.js';

/**
 * The screen: everything already said, whatever is streaming now, and the
 * prompt.
 *
 * Finished lines go through Ink's `Static`, which prints them once and lets the
 * terminal keep them — the live area stays small no matter how long the session
 * runs, which is what keeps a long conversation from being redrawn on every
 * token.
 *
 * The input here is deliberately minimal: one line, backspace, enter. Multi-line
 * paste, history and completion are their own task; this one only has to prove
 * that the session can be driven from Ink exactly as it was from readline.
 */
export function App({
  store,
  onSubmit,
  onChoose,
  onInterrupt,
  onCycleMode,
  commands,
}: {
  store: UiStore;
  onSubmit: (line: string) => void;
  onChoose: (value: string | null) => void;
  onInterrupt: () => void;
  onCycleMode: () => void;
  /** Command names, without the slash, for completion. */
  commands: string[];
}): React.ReactElement {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { exit } = useApp();

  useInput((input, key) => {
    if (key.ctrl && input === 'c') {
      store.close();
      exit();
      return;
    }

    // Esc stops the run rather than the CLI. It is the only key that does
    // anything while the agent is working, which is also when you need it.
    if (key.escape) {
      if (state.status.running) onInterrupt();
      return;
    }

    // A choice takes the keyboard while it is open: arrows move, enter picks,
    // and the letters still work for anyone who knows them by heart.
    if (state.selection) {
      if (key.upArrow) return store.moveSelection(-1);
      if (key.downArrow) return store.moveSelection(1);
      if (key.return) return onChoose(state.selection.choices[state.selection.index]?.value ?? null);

      const typed = input.trim().toLowerCase();
      const match = state.selection.choices.find(
        choice => (choice.key ?? choice.label[0] ?? '').toLowerCase() === typed,
      );
      if (match) onChoose(match.value);
      return;
    }

    if (state.prompt === null) return;

    // Shift+Tab cycles the mode, the way the mode indicator in the footer
    // suggests it should be cheap to change.
    if (key.tab && key.shift) {
      onCycleMode();
      return;
    }

    if (key.tab) {
      const [first] = state.completions;
      if (first) {
        const { start } = tokenAt(state.input, state.cursor);
        const next = state.input.slice(0, start) + first + (first.endsWith('/') ? '' : ' ');
        store.setInput(next);
        store.setCompletions([]);
      }
      return;
    }

    if (key.return) {
      const line = state.input;
      store.remember(line);
      onSubmit(line);
      return;
    }

    if (key.upArrow) return store.stepHistory(-1);
    if (key.downArrow) return store.stepHistory(1);
    if (key.leftArrow) return store.moveCursor(-1);
    if (key.rightArrow) return store.moveCursor(1);

    if (key.backspace || key.delete) {
      if (state.cursor === 0) return;

      const next = state.input.slice(0, state.cursor - 1) + state.input.slice(state.cursor);
      store.setInput(next, state.cursor - 1);
      store.setCompletions(suggest(next, state.cursor - 1));
      return;
    }

    if (!input || key.ctrl || key.meta) return;

    const action = interpret(input);
    if (action.kind === 'submit') {
      const line = state.input.slice(0, state.cursor) + action.text + state.input.slice(state.cursor);
      store.remember(line);
      onSubmit(line);
      return;
    }

    const next = state.input.slice(0, state.cursor) + action.text + state.input.slice(state.cursor);
    store.setInput(next, state.cursor + action.text.length);
    store.setCompletions(suggest(next, state.cursor + action.text.length));
  });

  /** What could finish what is being typed: a command, or a path. */
  function suggest(value: string, cursor: number): string[] {
    const commandMatches = completeCommand(value, commands).map(name => `/${name}`);
    if (commandMatches.length > 0) return commandMatches;

    const { token } = tokenAt(value, cursor);
    return completePath(token, PROJECT_DIR);
  }

  return (
    <Box flexDirection="column">
      <Static items={state.lines}>{line => <Text key={line.id}>{line.text}</Text>}</Static>

      {state.streaming ? <Text>{state.streaming}</Text> : null}

      {/* A pending decision is the only thing that matters: the checklist
          would otherwise sit between the question and its answers. */}
      {state.selection ? null : <Tasks tasks={state.tasks} />}

      {state.selection ? (
        <Box flexDirection="column">
          <Text color="yellow">{state.selection.prompt}</Text>
          {state.selection.choices.map((choice, index) => {
            const active = index === state.selection?.index;
            return (
              <Text key={choice.value} color={active ? 'cyan' : undefined} dimColor={!active}>
                {active ? '❯ ' : '  '}
                {choice.label}
                {choice.hint ? `  ${choice.hint}` : ''}
              </Text>
            );
          })}
        </Box>
      ) : null}

      {state.prompt !== null ? <Prompt state={state} /> : null}

      <Footer status={state.status} />
    </Box>
  );
}
