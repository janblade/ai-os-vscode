import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { memoryCheck, ContextChangedError } from '../src/core/context-memory';
import { Runner, RunStore } from '../src/core/runner';
import { parseWorkflow } from '../src/contracts';
import { ExecutionContext } from '../src/providers/context';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
test('selected Markdown revisions detect edits, replacement and deletion, ignoring unrelated files', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-memory-revision-'));
  try {
    await writeFile(path.join(root, 'task.md'), 'Original task');
    const check = memoryCheck(root, [{source:'task.md',sha256:hash('Original task')}]);
    await check(); await writeFile(path.join(root, 'unrelated.md'), 'Notes'); await check();
    await writeFile(path.join(root, 'task.md'), 'Changed task');
    await assert.rejects(check(), error => error instanceof ContextChangedError && error.sources[0] === 'task.md');
    await writeFile(path.join(root, 'task.md'), 'Original task'); await check();
    await rm(path.join(root, 'task.md')); await assert.rejects(check(), ContextChangedError);
  } finally { await rm(root, {recursive:true,force:true}); }
});

test('external Markdown edit interrupts a live run and preserves completed phases for recovery', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-stale-run-'));
  const store = new RunStore(path.join(root, '.runs'));
  const workflow = parseWorkflow(JSON.stringify({ version:1, id:'revision-test', name:'Revision test', nodes:[
    {id:'plan',kind:'agent',label:'Plan',position:{x:0,y:0},config:{provider:'mock',prompt:'Plan'}},
    {id:'build',kind:'agent',label:'Build',position:{x:100,y:0},config:{provider:'mock',prompt:'Build'}},
    {id:'test',kind:'agent',label:'Test',position:{x:200,y:0},config:{provider:'mock',prompt:'Test'}}
  ], edges:[{id:'p-b',source:'plan',target:'build',sourcePort:'success',targetPort:'in'},{id:'b-t',source:'build',target:'test',sourcePort:'success',targetPort:'in'}] }));
  const called: string[] = []; let entered!: () => void;
  const building = new Promise<void>(resolve => { entered = resolve; });
  const context: Omit<ExecutionContext,'runId'> = { repository:root,frameworkRoot:root,system:'',data:'',validate:async()=>{},checkMemory:memoryCheck(root,[{source:'task.md',sha256:hash('Original')}]),activity:async()=>{},session:async()=>{},approval:async()=>true,input:async()=>null };
  const runner = new Runner(store,{id:'mock',capabilities:{cancellation:true,resume:false,toolApprovals:false},execute:async(node,signal)=>{
    called.push(node.id); if(node.id !== 'build') return 'Verified phase';
    return new Promise<string>((_resolve,reject)=>{ signal.addEventListener('abort',()=>reject(signal.reason),{once:true}); entered(); });
  }},()=>{},error=>{throw error;});
  try {
    await writeFile(path.join(root,'task.md'),'Original');
    const run = await runner.start(workflow,'file:///workflow','file:///repo',undefined,context);
    await building; await writeFile(path.join(root,'task.md'),'New instruction');
    await runner.revalidate(); await runner.wait(run.id);
    const saved = (await store.list())[0];
    assert.equal(saved.status,'interrupted'); assert.equal(saved.steps.plan.status,'succeeded');
    assert.equal(saved.steps.build.status,'interrupted'); assert.equal(saved.steps.test.status,'queued');
    assert.match(saved.error!,/Run context changed: task.md/); assert.deepEqual(called,['plan','build']);
  } finally { await runner.stop(); await rm(root,{recursive:true,force:true}); }
});
