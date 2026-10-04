import { MessageList } from '@mastra/core/agent';
import { createSignal } from '@mastra/core/signals';

const MARKER = 'stay on the current task';
const list = new MessageList({ threadId: 't1' });
list.add([{ role: 'user', content: 'hello' }], 'input');

list.addSignal(createSignal({ id: 'r1', type: 'reactive', contents: MARKER, transient: true }) as any);
list.addSignal(createSignal({ id: 'k1', type: 'reactive', contents: 'PERSISTED reminder' }) as any);

const prompt: any[] = list.get.all.aiV5.prompt() as any;
for (const m of prompt) {
  if (!Array.isArray(m.content)) continue;
  for (const part of m.content) {
    if (part.type !== 'text') continue;
    const kind = part.text.includes(MARKER) ? 'TRANSIENT' : part.text.includes('PERSISTED') ? 'non-transient' : null;
    if (!kind) continue;
    console.log(`${kind.padEnd(14)} -> providerOptions.mastra =`, JSON.stringify(part.providerOptions?.mastra));
  }
}
const t = prompt.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((p:any)=>p.type==='text'&&p.text.includes(MARKER));
const n = prompt.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).find((p:any)=>p.type==='text'&&p.text.includes('PERSISTED'));
console.log('');
console.log(`transient marked      : ${t?.providerOptions?.mastra?.transient === true ? 'PASS' : 'FAIL'}`);
console.log(`non-transient unmarked: ${n?.providerOptions?.mastra?.transient === undefined ? 'PASS' : 'FAIL'}`);
