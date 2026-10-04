import { render } from 'ink';
// In scope because the JSX here compiles to `React.createElement`: tsconfig
// says `jsx: react` for that reason. It briefly said `react-jsx`, the compiler
// reported this import as unused, removing it threw at the first render.
import React from 'react';
import { App } from './app.js';
import type { Io } from './io.js';
import { UiStore, type Choice, type UiStatus } from './store.js';

/**
 * The Ink implementation of {@link Io}.
 *
 * `ask` is a promise the app resolves when a line is submitted: the session
 * keeps its "ask a question, await the answer" shape, and only the thing
 * collecting the answer has changed. One question is outstanding at a time,
 * which is already how the session behaves — an approval blocks the prompt.
 */
export function createInkIo(options: { commands: string[] } = { commands: [] }): Io {
  const store = new UiStore();

  let pending: ((answer: string | null) => void) | null = null;
  let choosing: ((value: string | null) => void) | null = null;

  const submit = (line: string) => {
    const resolve = pending;
    pending = null;
    store.setPrompt(null);

    // Echo the answer: it is part of the transcript, and without it the screen
    // loses what was typed as soon as the prompt goes away.
    store.line(line);
    resolve?.(line);
  };

  const choose = (value: string | null) => {
    const resolve = choosing;
    choosing = null;

    const selection = store.getSnapshot().selection;
    store.setSelection(null);

    // Leave the decision on screen: what you chose is part of the transcript.
    const chosen = selection?.choices.find(choice => choice.value === value);
    if (chosen) store.line(`  → ${chosen.label}`);

    resolve?.(value);
  };

  let interrupt: () => void = () => {};
  let cycleMode: () => void = () => {};

  const app = render(
    <App
      store={store}
      onSubmit={submit}
      onChoose={choose}
      onInterrupt={() => interrupt()}
      onCycleMode={() => cycleMode()}
      commands={options.commands}
    />,
    {
    // Ink prints anything written to console above the app rather than letting
    // it tear through the drawing. Mastra and our own debug lines rely on it.
      patchConsole: true,
      exitOnCtrlC: false,
    },
  );

  app.waitUntilExit().then(() => {
    store.close();
    pending?.(null);
    choosing?.(null);
    pending = null;
    choosing = null;
  });

  return {
    interactive: true,

    ask(prompt: string): Promise<string | null> {
      if (store.getSnapshot().closed) return Promise.resolve(null);

      return new Promise<string | null>(resolve => {
        pending = resolve;
        store.setPrompt(prompt);
      });
    },

    select(prompt: string, choices: Choice[]): Promise<string | null> {
      if (store.getSnapshot().closed) return Promise.resolve(null);

      return new Promise<string | null>(resolve => {
        choosing = resolve;
        store.setSelection({ prompt, choices, index: 0 });
      });
    },

    line(text = '') {
      store.line(text);
    },

    setStatus(patch: Partial<UiStatus>) {
      store.setStatus(patch);
    },

    setTasks(tasks) {
      store.setTasks(tasks);
    },

    onInterrupt(handler: () => void) {
      interrupt = handler;
    },

    onCycleMode(handler: () => void) {
      cycleMode = handler;
    },

    write(text: string) {
      store.write(text);
    },

    async close() {
      store.close();
      app.unmount();
      await app.waitUntilExit();
    },
  };
}
