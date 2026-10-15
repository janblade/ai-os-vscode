import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { automaticEditEligible, automaticPolicyAllows } from '../src/providers/automatic-approval';
import { Runner, RunStore } from '../src/core/runner';
import { exampleWorkflow, Run } from '../src/contracts';
import { ExecutionContext } from '../src/providers/context';

test('automatic file consent is restricted to repository edits and explicit permissive policy', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-auto-'));
  const repo = path.join(root,'repo'); await mkdir(repo);
  const eligible = (paths: string[], archetype='hobby') => automaticEditEligible(repo,root,archetype,{kind:'fileEdit',paths,operation:'update'});
  try {
    assert.equal(await eligible(['src/code.ts']), true);
    for (const files of [[], ['../escape.ts'], [path.join(root,'.ai-os/agents/a.json')], ['.ai-os/progress.md'], ['.vscode/settings.json'], ['src/AGENTS.md'], ['.env'], ['src/code.ts','.git/config']]) assert.equal(await eligible(files), false);
    for (const archetype of ['enterprise','critical','unknown']) assert.equal(await eligible(['code.ts'],archetype), false);
    assert.equal(await automaticEditEligible(repo,root,'hobby',undefined),false);
    assert.equal(await automaticEditEligible(repo,root,'hobby',{kind:'command',paths:['code.ts']} as any),false);
    for (const operation of ['delete','unknown',undefined] as const) assert.equal(await automaticEditEligible(repo,root,'startup',{kind:'fileEdit',paths:['src/code.ts'],operation}),false);
    const permissive = {governance:{human_approval:'never',code_review:'none'},rule_overrides:{R15:'disabled'}};
    assert.equal(automaticPolicyAllows('hobby',permissive),true);
    assert.equal(automaticPolicyAllows('critical',permissive),false);
    assert.equal(automaticPolicyAllows('hobby',{}),false);
    assert.equal(automaticPolicyAllows('hobby',{...permissive,rule_overrides:{R15:'all-actions'}}),false);
    assert.equal(automaticPolicyAllows('hobby',{...permissive,governance:{human_approval:'all-actions',code_review:'all-changes'}}),false);
  } finally { await rm(root,{recursive:true,force:true}); }
});

test('runner auto-allows eligible edits with activity, while commands and agent gates stay manual', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(),'aios-auto-run-'));
  try {
    for (const gated of [false,true]) {
      const store = new RunStore(path.join(root,String(gated))); const events: Run[] = [];
      let automatic = 0; let manual = 0;
      const context: Omit<ExecutionContext,'runId'> = {repository:root,frameworkRoot:root,system:'',data:'',validate:async()=>{},activity:async()=>{},session:async()=>{},input:async()=>null,automaticApproval:async()=>{automatic++;return true;},approval:async()=>{manual++;return true;}};
      const flow = exampleWorkflow('automatic'); flow.nodes[0].config.agentSnapshot = gated ? {approval_gate:'Human review required'} : undefined;
      const runner = new Runner(store,{id:'mock',capabilities:{cancellation:true,resume:false,toolApprovals:true},execute:async(_node,_signal,bound)=>{
        assert.equal(await bound!.approval('Edit code','diff',{kind:'fileEdit',paths:['src/code.ts'],operation:'update'}),true);
        assert.equal(await bound!.approval('Run command','command'),true); return 'Verified';
      }},run=>events.push(run),error=>{throw error;});
      try {
        const run = await runner.start(flow,'file:///flow','file:///repo',undefined,context);
        for(let count=0;count<200 && !events.some(run=>run.steps.review.status==='waitingApproval');count++) await new Promise(resolve=>setTimeout(resolve,10));
        runner.approve(run.id); await runner.wait(run.id);
        assert.equal(automatic,gated?0:1); assert.equal(manual,gated?2:1);
        assert.equal(events.some(run=>run.steps.plan.events?.some(event=>event.summary.includes('Automatically allowed'))),!gated);
      } finally { await runner.stop(); }
    }
  } finally { await rm(root,{recursive:true,force:true}); }
});
