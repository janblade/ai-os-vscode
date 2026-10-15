import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Run, Workflow, parseWorkflow } from '../src/contracts';
import { parseDashboardMessage } from '../src/dashboard-contracts';
import { Runner, RunStore, parseRun } from '../src/core/runner';
import { AgentProvider } from '../src/providers/mock';
import { createFile, readText } from '../src/core/files';
import { applyProposal, parseProposal, hash, verifyProposal } from '../src/framework/memory-proposal';
import { skippable } from '../src/core/run-finish';
async function until(predicate:()=>boolean) { for(let i=0;i<200;i++){if(predicate())return;await new Promise(resolve=>setTimeout(resolve,10));} assert.fail('Runner did not reach gate'); }
function workflow(): Workflow {
  const nodes: Workflow['nodes'] = [
    {id:'plan',kind:'agent',label:'Plan',position:{x:0,y:0},config:{provider:'mock',prompt:'Plan'}},
    {id:'approve',kind:'approval',label:'Approval',position:{x:1,y:0},config:{}},
    {id:'optional',kind:'agent',label:'Extra explanation',position:{x:2,y:0},config:{provider:'mock',prompt:'Explain',optional:true,readOnly:true}},
    {id:'test',kind:'agent',label:'Required verification',position:{x:3,y:0},config:{provider:'mock',prompt:'Test',requireVerification:true,optional:true,readOnly:true}},
    {id:'review',kind:'approval',label:'Final review',position:{x:4,y:0},config:{}}
  ];
  return parseWorkflow(JSON.stringify({version:1,id:'finish-test',name:'Finish test',nodes,edges:nodes.slice(1).map((node,index)=>({id:`edge-${index}`,source:nodes[index].id,target:node.id,sourcePort:'success',targetPort:'in'}))}));
}
test('skip only pending optional informational phases, keep gates, never record full success',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aios-finish-')); const store=new RunStore(root); const events:Run[]=[]; const called:string[]=[];
  const provider:AgentProvider={id:'mock',capabilities:{cancellation:true,resume:false,toolApprovals:false},execute:async node=>{called.push(node.id);return node.id==='test'?JSON.stringify({status:'passed',summary:'Actual fixture verified',verification:['Fixture assertion']}):'Plan';}};
  const runner=new Runner(store,provider,run=>events.push(run),error=>{throw error;});
  try {
    const run=await runner.start(workflow(),'file:///workflow','file:///repository');
    await until(()=>events.at(-1)?.steps.approve.status==='waitingApproval');
    for(const nodes of [['test'],['approve'],['plan'],['optional','missing'],['optional','optional']]) await assert.rejects(runner.skipOptional(run.id,nodes,'Not needed'));
    assert.equal(events.at(-1)!.steps.optional.status,'queued');
    await runner.skipOptional(run.id,['optional'],'Supplementary explanation not needed');
    assert.equal(parseRun(JSON.stringify(events.at(-1))).steps.optional.skipReason,'Supplementary explanation not needed');
    runner.approve(run.id,'approve'); await until(()=>events.at(-1)?.steps.review.status==='waitingApproval');
    assert.deepEqual(called,['plan','test']);
    runner.approve(run.id,'review'); await runner.wait(run.id);
    const saved=events.at(-1)!; assert.equal(saved.status,'cancelled'); assert.match(saved.error!,/unverified/);
    await assert.rejects(runner.skipOptional(run.id,['optional'],'Again'),/active regular/);
    await assert.rejects(runner.recover(saved,'retry',{validate:async()=>{}} as any),/fresh workflow/);
    const forged=structuredClone(saved); forged.steps.test={status:'cancelled',skipReason:'Fake required test skip'};
    assert.throws(()=>parseRun(JSON.stringify(forged)),/Invalid skipped phase/);
  }finally{await runner.stop();await rm(root,{recursive:true,force:true});}
});
test('agent approval gates and writable phases cannot be skipped',()=>{
  const node=workflow().nodes[2]; assert.equal(skippable(node),true);
  assert.equal(skippable({...node,config:{...node.config,agentSnapshot:{approval_gate:'review'}}}),false);
  assert.equal(skippable({...node,config:{...node.config,readOnly:false}}),false);
  assert.throws(()=>parseWorkflow(JSON.stringify({...workflow(),nodes:[{...node,config:{...node.config,optional:'yes'}}],edges:[]})),/Invalid step/);
});
test('finish messages require explicit action, run identity, reason and bounded unique phase IDs',()=>{
  const message={type:'finishRun',id:'run:test',revision:1,runId:randomUUID(),mode:'skip',reason:'Unneeded extra explanation',nodeIds:['optional']};
  assert.deepEqual(parseDashboardMessage(message),message);
  for(const extra of [{reason:''},{mode:'pass'},{nodeIds:['optional','optional']},{runId:'other'},{mode:'close'},{unexpected:true}]) assert.throws(()=>parseDashboardMessage({...message,...extra}));
  assert.deepEqual(parseDashboardMessage({...message,mode:'wrap',nodeIds:[]}),{...message,mode:'wrap',nodeIds:[]});
});


test('reviewed continuity proposals append one session without changing history or duplicating sessions',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aios-continuity-'));
  const entry={session_id:'origin-run',started:null,ended:'2026-10-16T03:00:00+08:00',summary:'Focused tests passed; runtime still unverified',next_up:'Perform runtime acceptance'};
  const evidence='.ai-os/memory/tasks/task.md';
  await createFile(root,evidence,'Task evidence');
  const base={version:1,expectedHash:null,content:JSON.stringify(entry)+'\n',reason:'Save session handoff without promotion',evidence:[{scope:'framework',source:evidence,sha256:hash('Task evidence')}]};
  try {
    const history='.ai-os/memory/episodic/sessions.jsonl';
    const proposal=parseProposal(JSON.stringify({...base,target:history}));
    let validations=0;await applyProposal(root,root,proposal,async()=>{validations++;});
    assert.ok(validations>=2);const original=await readText(root,history);
    await applyProposal(root,root,proposal,async()=>{});assert.equal(await readText(root,history),original);
    await assert.rejects(verifyProposal(root,root,parseProposal(JSON.stringify({...base,target:history,expectedHash:hash(original),content:original+JSON.stringify(entry)+'\n'}))),/already recorded/);
    await assert.rejects(verifyProposal(root,root,parseProposal(JSON.stringify({...base,target:history,expectedHash:hash(original),content:JSON.stringify({...entry,session_id:'another'})+'\n'}))),/without changing history/);
    const last=parseProposal(JSON.stringify({...base,target:'.ai-os/memory/episodic/last_session.json'}));
    await applyProposal(root,root,last,async()=>{});assert.deepEqual(JSON.parse(await readText(root,last.target)),entry);
    for(const extra of [{target:'.ai-os/memory/episodic/decisions.jsonl'},{target:last.target,content:'{}'},{target:history,content:JSON.stringify(entry)}]) assert.throws(()=>parseProposal(JSON.stringify(Object.assign({...base,target:history},extra))));
  }finally{await rm(root,{recursive:true,force:true});}
});


test('final provider launch validation stops execution if the finalization context changed',async()=>{
  const root=await mkdtemp(path.join(os.tmpdir(),'aios-launch-check-')); const store=new RunStore(root);let calls=0;
  const provider:AgentProvider={id:'mock',capabilities:{cancellation:true,resume:false,toolApprovals:false},execute:async()=>{calls++;return 'Unexpected execution';}};
  const runner=new Runner(store,provider,()=>{},error=>{throw error;});
  try{
    const flow=workflow();flow.nodes=[flow.nodes[0]];flow.edges=[];
    const run=await runner.start(flow,'file:///workflow','file:///repo',undefined,{validate:async()=>{},data:'',system:'',beforeExecute:async()=>{throw new Error('Accepted repository revision changed');}} as any);
    await runner.wait(run.id);assert.equal(calls,0);assert.match((await store.list())[0].error!,/Accepted repository revision changed/);
  }finally{await runner.stop();await rm(root,{recursive:true,force:true});}
});
