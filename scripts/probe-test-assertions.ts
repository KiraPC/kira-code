/** Mirrors the assertions of packages/core/.../message-list-transient-signal.test.ts against the dist. */
import { MessageList } from '@mastra/core/agent';
import { createSignal } from '@mastra/core/signals';

const MARKER = 'stay on the current task';
const newList = () => { const l = new MessageList({ threadId: 't' }); l.add([{ role: 'user', content: 'hello' }], 'input'); return l; };
const texts = (l: any): string[] => l.get.all.aiV5.prompt().map((m: any) =>
  typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '');
const sendT = (l: any, id = 'reminder-1') => l.addSignal(createSignal({ id, type: 'reactive', contents: MARKER, transient: true }) as any);
const flagOf = (l: any, marker: string) => {
  const parts = l.get.all.aiV5.prompt().flatMap((m: any) => Array.isArray(m.content) ? m.content : []);
  return parts.find((p: any) => p.type === 'text' && p.text.includes(marker))?.providerOptions?.mastra?.transient;
};
const R: [string, boolean][] = [];

{ const l = newList(); sendT(l); sendT(l); sendT(l);
  R.push(['1 db signal row after 3 re-sends', l.get.all.db().filter((m: any) => m.role === 'signal').length === 1]);
  R.push(['1 copy in prompt', texts(l).filter(t => t.includes(MARKER)).length === 1]); }

{ const l = newList(); sendT(l); l.add([{ role: 'assistant', content: 'a1' }], 'response'); sendT(l);
  l.add([{ role: 'assistant', content: 'a2' }], 'response'); sendT(l); const t = texts(l);
  R.push(['1 copy while transcript grows', t.filter(x => x.includes(MARKER)).length === 1]);
  R.push(['reminder is the LAST prompt entry', t[t.length - 1]!.includes(MARKER)]); }

{ const l = newList(); sendT(l);
  R.push(['transient flag === true on projection', flagOf(l, MARKER) === true]); }

{ const l = newList(); l.addSignal(createSignal({ id: 'kept-1', type: 'reactive', contents: MARKER }) as any);
  R.push(['non-transient flag undefined', flagOf(l, MARKER) === undefined]); }

{ const l = newList(); l.addSignal(createSignal({ id: 'kept-1', type: 'reactive', contents: MARKER }) as any);
  l.add([{ role: 'assistant', content: 'answer' }], 'response');
  l.addSignal(createSignal({ id: 'kept-1', type: 'reactive', contents: MARKER }) as any);
  const t = texts(l);
  R.push(['non-transient: 1 copy', t.filter(x => x.includes(MARKER)).length === 1]);
  R.push(['non-transient: NOT last', !t[t.length - 1]!.includes(MARKER)]); }

for (const [name, ok] of R) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
console.log(`\n${R.filter(r => r[1]).length}/${R.length} assertions hold against the dist`);
