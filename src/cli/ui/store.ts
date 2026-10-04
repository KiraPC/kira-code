/**
 * The state the Ink app draws, kept outside React.
 *
 * The session drives the CLI through plain function calls (`line`, `write`,
 * `ask`), and React only reacts. Keeping the state here rather than in a
 * component means the session never has to know a renderer exists — which is
 * what lets the same code run against a pipe.
 */
/**
 * What the footer shows. Session facts the CLI already knows, plus what only the
 * event stream can tell: whether a run is in flight, and how full the window is.
 */
export type UiStatus = {
  mode: string;
  model: string;
  cache: string;
  running: boolean;
  /** When the current run started, for the elapsed clock. */
  startedAt: number | null;
  tokens: number;
  contextTokens: number;
  contextThreshold: number;
};

import type { TaskItem } from '../session/events';

/** One option in a selection. `key` is the letter that picks it on a pipe. */
export type Choice = { value: string; label: string; hint?: string; key?: string };

export type UiState = {
  /** Finished lines, rendered once and left alone as the screen scrolls. */
  lines: { id: number; text: string }[];
  /** Text still streaming in from the model. */
  streaming: string;
  /** The prompt awaiting an answer, or null when nothing is being asked. */
  prompt: string | null;
  /** What has been typed so far in reply. */
  input: string;
  /** Set when input is over: EOF, or Ctrl-C. */
  closed: boolean;
  status: UiStatus;
  /** The choice being made, or null when nothing is being chosen. */
  selection: { prompt: string; choices: Choice[]; index: number } | null;
  /** The agent's task list, drawn live rather than scrolled past. */
  tasks: TaskItem[];
  /** Where the caret sits in `input`. */
  cursor: number;
  /** Lines submitted this session, newest last, for the arrow keys. */
  history: string[];
  /** Where the arrows are in `history`, or null when editing a fresh line. */
  historyIndex: number | null;
  /** Completions offered for what is being typed. */
  completions: string[];
};

const initial: UiState = {
  lines: [],
  streaming: '',
  prompt: null,
  input: '',
  closed: false,
  selection: null,
  tasks: [],
  cursor: 0,
  history: [],
  historyIndex: null,
  completions: [],
  status: {
    mode: '',
    model: '',
    cache: '',
    running: false,
    startedAt: null,
    tokens: 0,
    contextTokens: 0,
    contextThreshold: 0,
  },
};

export class UiStore {
  #state: UiState = initial;
  #listeners = new Set<() => void>();
  #nextId = 0;

  getSnapshot = (): UiState => this.#state;

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  #set(patch: Partial<UiState>): void {
    this.#state = { ...this.#state, ...patch };
    for (const listener of this.#listeners) listener();
  }

  /** Appends a finished line, flushing whatever was mid-stream before it. */
  line(text: string): void {
    const pending = this.#state.streaming;
    const entries = pending ? [pending, text] : [text];

    this.#set({
      lines: [...this.#state.lines, ...entries.map(entry => ({ id: this.#nextId++, text: entry }))],
      streaming: '',
    });
  }

  /**
   * Appends streamed text. A newline ends the fragment and turns it into a
   * finished line, so long answers scroll away instead of being redrawn whole.
   */
  write(text: string): void {
    const combined = this.#state.streaming + text;
    const parts = combined.split('\n');
    const trailing = parts.pop() ?? '';

    if (parts.length === 0) {
      this.#set({ streaming: trailing });
      return;
    }

    this.#set({
      lines: [...this.#state.lines, ...parts.map(part => ({ id: this.#nextId++, text: part }))],
      streaming: trailing,
    });
  }

  setStatus(patch: Partial<UiStatus>): void {
    this.#set({ status: { ...this.#state.status, ...patch } });
  }

  setTasks(tasks: TaskItem[]): void {
    this.#set({ tasks });
  }

  setSelection(selection: UiState['selection']): void {
    this.#set({ selection });
  }

  moveSelection(delta: number): void {
    const current = this.#state.selection;
    if (!current) return;

    const count = current.choices.length;
    this.#set({ selection: { ...current, index: (current.index + delta + count) % count } });
  }

  setPrompt(prompt: string | null): void {
    this.#set({ prompt, input: '', cursor: 0, historyIndex: null, completions: [] });
  }

  setInput(input: string, cursor = input.length): void {
    this.#set({ input, cursor: Math.max(0, Math.min(cursor, input.length)) });
  }

  moveCursor(delta: number): void {
    this.setInput(this.#state.input, this.#state.cursor + delta);
  }

  setCompletions(completions: string[]): void {
    this.#set({ completions });
  }

  /** Records a submitted line, so the arrows can bring it back. */
  remember(line: string): void {
    if (!line.trim()) return;

    const history = [...this.#state.history.filter(entry => entry !== line), line];
    this.#set({ history: history.slice(-100), historyIndex: null });
  }

  /**
   * Steps through history. -1 is older, +1 newer; stepping past the newest
   * entry returns to the empty line you were on.
   */
  stepHistory(delta: number): void {
    const { history, historyIndex } = this.#state;
    if (history.length === 0) return;

    const current = historyIndex ?? history.length;
    const next = Math.max(0, Math.min(history.length, current + delta));

    if (next >= history.length) {
      this.#set({ historyIndex: null, input: '', cursor: 0 });
      return;
    }

    const line = history[next] ?? '';
    this.#set({ historyIndex: next, input: line, cursor: line.length });
  }

  close(): void {
    this.#set({ closed: true, prompt: null });
  }
}
