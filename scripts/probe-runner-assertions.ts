/** Mirrors the appended assertions of packages/core/src/processors/sendSignal-integration.test.ts. */
import { MessageList } from '@mastra/core/agent';
import { ProcessorRunner } from '@mastra/core/processors';

const MARKER = 'stay on the current task';
const logger: any = { debug(){}, info(){}, warn(){}, error(){}, trackException(){}, getTransports:()=>[], listLogs:()=>[], listLogsByRunId:()=>[] };
const text = (m: any) => typeof m.content === 'string' ? m.content
  : Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text).join('\n') : '';

function makeRunner(mode: 'nothing'|'messageList'|'ctxMessages'|'nonTransient') {
  return new ProcessorRunner({
    inputProcessors: [{
      id: mode === 'nonTransient' ? 'persisted-reminder' : 'steering-reminder',
      processInputStep: async (args: any) => {
        await args.sendSignal?.({ type: 'reactive', contents: MARKER, ...(mode === 'nonTransient' ? {} : { transient: true }) });
        if (mode === 'messageList') return args.messageList;
        if (mode === 'ctxMessages') return args.messages;
        return undefined;
      },
    }] as any,
    outputProcessors: [], logger, agentName: 'test-agent',
  } as any);
}

async function runSteps(runner: any, list: any, steps: number) {
  const seen: { copies: number; lastIndex: number; total: number }[] = [];
  for (let step = 0; step < steps; step++) {
    if (step > 0) list.add([{ role: 'assistant', content: `step ${step - 1}` }], 'response');
    await runner.runProcessInputStep({
      messageList: list, stepNumber: step, steps: [], model: {} as any, tools: {},
      retryCount: 0, messageId: `response-${step}`, writer: { custom: async () => {} },
    });
    const prompt: any[] = list.get.all.aiV5.prompt();
    const t = prompt.map(text);
    seen.push({ copies: t.filter(x => x.includes(MARKER)).length, lastIndex: t.reduce((a, x, i) => x.includes(MARKER) ? i : a, -1), total: prompt.length });
  }
  return seen;
}
const fresh = () => { const l = new MessageList({ threadId: 'test-thread' }); l.add([{ role: 'user', content: 'hello' }], 'input'); return l; };
const R: [string, boolean, string][] = [];

for (const mode of ['nothing','messageList'] as const) {
  const l = fresh(); const seen = await runSteps(makeRunner(mode), l, 4);
  R.push([`${mode}: copies [1,1,1,1]`, JSON.stringify(seen.map(s=>s.copies))===JSON.stringify([1,1,1,1]), JSON.stringify(seen.map(s=>s.copies))]);
  R.push([`${mode}: reminder last every step`, seen.every(s=>s.lastIndex===s.total-1), JSON.stringify(seen.map(s=>`${s.lastIndex}/${s.total-1}`))]);
}
{ const l = fresh(); await runSteps(makeRunner('nothing'), l, 3);
  const ids = l.get.all.db().filter((m:any)=>m.role==='signal').map((m:any)=>m.id);
  R.push(['stable id === transient:steering-reminder:system-reminder', ids.length===1 && ids[0]==='transient:steering-reminder:system-reminder', JSON.stringify(ids)]); }
{ const l = fresh(); const seen = await runSteps(makeRunner('ctxMessages'), l, 4);
  R.push(['ctxMessages: no duplication [1,1,1,1]', JSON.stringify(seen.map(s=>s.copies))===JSON.stringify([1,1,1,1]), JSON.stringify(seen.map(s=>s.copies))]);
  R.push(['ctxMessages: 1 db signal row', l.get.all.db().filter((m:any)=>m.role==='signal').length===1, '']); }
{ const l = fresh(); const seen = await runSteps(makeRunner('nonTransient'), l, 3);
  R.push(['non-transient: accumulates [1,2,3]', JSON.stringify(seen.map(s=>s.copies))===JSON.stringify([1,2,3]), JSON.stringify(seen.map(s=>s.copies))]); }

for (const [n, ok, got] of R) console.log(`${ok?'PASS':'FAIL'}  ${n}${ok?'':`   got=${got}`}`);
console.log(`\n${R.filter(r=>r[1]).length}/${R.length} assertions hold`);
