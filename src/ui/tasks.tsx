import { Box, Text } from 'ink';
import React from 'react';
import type { TaskItem } from '../session/events.js';

/**
 * The agent's own checklist, drawn where you can see it change.
 *
 * It kept this list all along — a job of three steps or more is supposed to go
 * through the task tools, and it does — but the calls arrived as a line of JSON
 * cut at a hundred characters, so the plan the agent was following was
 * effectively private. Here it stays on screen, and the line it is working on
 * is the one you can point at.
 */
const MARK = {
  completed: { symbol: '✔', color: 'green' as const },
  in_progress: { symbol: '❯', color: 'cyan' as const },
  pending: { symbol: '○', color: undefined },
};

export function Tasks({ tasks }: { tasks: TaskItem[] }): React.ReactElement | null {
  // Once everything is done the list has nothing left to say, and the screen is
  // better spent on what comes next.
  if (tasks.length === 0 || tasks.every(task => task.status === 'completed')) return null;

  return (
    <Box flexDirection="column" marginTop={1}>
      {tasks.map((task, index) => {
        const mark = MARK[task.status] ?? MARK.pending;
        const active = task.status === 'in_progress';

        return (
          <Text key={task.id ?? index} color={mark.color} dimColor={task.status === 'completed'}>
            {`${mark.symbol} `}
            {active && task.activeForm ? task.activeForm : task.content}
          </Text>
        );
      })}
    </Box>
  );
}
