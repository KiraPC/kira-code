import { Box, Text, useStdout } from 'ink';
import React, { useEffect, useState } from 'react';
import type { UiStatus } from './store.js';

/**
 * The line that never scrolls away: what the session is set to, and what it is
 * doing right now.
 *
 * All of it was already reachable — `/mode`, `/model`, `/cache`, `/context`,
 * `/usage` — but only by asking, one command at a time, which is no use while
 * the agent is working. That is exactly when it matters: how long this has been
 * going, how much of the window is gone, whether it can still be stopped.
 */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

function useTick(active: boolean, everyMs: number): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;

    const timer = setInterval(() => setTick(value => value + 1), everyMs);
    // Without this the process would not exit while a run is in flight.
    timer.unref?.();
    return () => clearInterval(timer);
  }, [active, everyMs]);

  return tick;
}

function elapsed(startedAt: number | null, now: number): string {
  if (!startedAt) return '';

  const seconds = Math.max(0, Math.round((now - startedAt) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${String(seconds % 60).padStart(2, '0')}s`;
}

function compact(tokens: number): string {
  return tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
}

export function Footer({ status }: { status: UiStatus }): React.ReactElement | null {
  const tick = useTick(status.running, 120);
  const { stdout } = useStdout();
  if (!status.mode) return null;

  // Wrapped onto two lines the footer stops being a footer. On a narrow
  // terminal the least useful parts go first: the hint you only need once, then
  // the token count.
  const columns = stdout?.columns ?? 80;
  const roomy = columns >= 96;
  const medium = columns >= 76;

  // The model id without its provider: the provider is the same all session and
  // the width is better spent on what changes.
  const model = status.model.includes('/') ? status.model.split('/').slice(1).join('/') : status.model;

  const context =
    status.contextThreshold > 0
      ? ` · context ${Math.round((status.contextTokens / status.contextThreshold) * 100)}%`
      : '';

  return (
    <Box>
      <Text dimColor>
        {status.mode} · {model} · cache {status.cache}
        {context}
      </Text>

      {status.running ? (
        <Text>
          {'  '}
          <Text color="cyan">{FRAMES[tick % FRAMES.length]}</Text>
          <Text dimColor>
            {' '}
            {elapsed(status.startedAt, Date.now())}
            {status.tokens > 0 && medium ? ` · ${compact(status.tokens)} tokens` : ''}
            {roomy ? ' · esc to interrupt' : ''}
          </Text>
        </Text>
      ) : null}
    </Box>
  );
}
