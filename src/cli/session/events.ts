/**
 * What a renderer is told, as facts rather than as text.
 *
 * The CLI used to format inside the event listener: a tool call became a dim
 * line right where it was received. That works for one renderer and blocks the
 * next — a diff, a live checklist or a footer needs the arguments and the
 * result, not the sentence someone already made out of them.
 *
 * So the listener maps the session's raw events onto this vocabulary, and each
 * renderer decides what to draw. The plain one rebuilds exactly the lines the
 * CLI printed before; the Ink one can do better with the same material.
 */
/** One entry of the list the agent keeps with the task tools. */
export type TaskItem = {
  id?: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm?: string;
};

export type UiEvent =
  /** A fragment of assistant text, already reduced to the new part. */
  | { type: 'assistant'; text: string }
  | { type: 'tool-start'; id: string; name: string; args: unknown }
  | {
      type: 'tool-end';
      id: string;
      name: string;
      /** The arguments, carried through so a result can be shown against them. */
      args: unknown;
      result: unknown;
      isError: boolean;
      /**
       * A written file's content from *before* the call. Captured when the call
       * started, because by the time it ends the old text is gone and there is
       * nothing left to diff against.
       */
      previous?: string;
    }
  /** The whole list, after whichever task tool just changed it. */
  | { type: 'tasks'; tasks: TaskItem[] }
  | { type: 'mode'; mode: string }
  | { type: 'model'; model: string }
  /** Observational memory's view of the window, on every step. */
  | { type: 'context'; tokens: number; threshold: number; pending: number }
  /**
   * A run began streaming — the first one of a turn, and every one that
   * resumes after an approval or a plan.
   */
  | { type: 'run-start' }
  /** The run reached a terminal state; `reason` is absent when it simply finished. */
  | { type: 'run-end'; reason?: string }
  | { type: 'error'; message: string }
  /** The raw event stream, only under KIRA_DEBUG. */
  | { type: 'debug'; text: string };

/** Anything that can draw a session. */
export type Renderer = {
  handle(event: UiEvent): void;
};
