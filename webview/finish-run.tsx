import { useState } from 'react';
import { Run } from '../src/contracts';
import { FinishAction, skippable } from '../src/core/run-finish';
export type FinishRequest = {runId:string;mode:FinishAction;reason:string;nodeIds:string[]};
export function FinishRun({run,active,enabled,submit,cancel}: {run:Run;active:boolean;enabled:boolean;submit:(request:FinishRequest)=>void;cancel:()=>void}) {
  const [mode,setMode] = useState<FinishAction>('wrap');
  const [reason,setReason] = useState('');
  const [nodes,setNodes] = useState<string[]>([]);
  const optional = run.workflow.nodes.filter(node=>skippable(node) && run.steps[node.id].status==='queued');
  return <form className="task-form" aria-label="Finish early" onSubmit={event=>{event.preventDefault();submit({runId:run.id,mode,reason:reason.trim(),nodeIds:mode==='skip'?nodes:[]});}}>
    <h3>Finish early</h3><p>Existing edits remain. Skipped or unverified checks never count as passed.</p>
    <label htmlFor="finish-action">Action</label><select id="finish-action" value={mode} onChange={event=>setMode(event.target.value as FinishAction)}>
      <option value="wrap" disabled={!run.taskUri}>Wrap up - save handoff, keep task open</option>
      <option value="close" disabled={!run.taskUri || active || !run.review}>Request task closure - run TASK_CLOSE checks</option>
      <option value="skip" disabled={!active || !optional.length || Boolean(run.finalization)}>Skip optional pending phases</option>
    </select>
    {mode==='skip'?<><p>Only optional read-only informational phases qualify. Required verification and approvals remain.</p>{optional.map(node=><label key={node.id}><input type="checkbox" checked={nodes.includes(node.id)} onChange={event=>setNodes(event.target.checked?[...nodes,node.id]:nodes.filter(id=>id!==node.id))}/>{node.label}</label>)}</>:<p>{active?'The current agent will be stopped and its exit awaited. ':''}A new native {mode==='wrap'?'WRAP session prepares continuity and a task handoff. The task stays open.':'TASK_CLOSE session checks the registered closure requirements. This does not automatically mark the task done; memory promotion and archival still require their own gates.'} Tool approvals and reviewed memory operations still apply.</p>}
    {run.taskUri && (active || !run.review) && <p>For task closure, stop the run, then review and accept the current repository changes first.</p>}
    {!run.taskUri && <p>Wrap-up and closure require a bound task.</p>}
    <label>Reason / accepted scope<textarea required maxLength={16000} value={reason} onChange={event=>setReason(event.target.value)} placeholder="Why finish here? What remains unverified?"/></label>
    <button disabled={!enabled || !reason.trim() || (mode==='skip'? !active || !nodes.length || nodes.some(id=>!optional.some(node=>node.id===id)):!run.taskUri || mode==='close' && (active || !run.review))}>Review finish action</button><button type="button" className="secondary" onClick={cancel}>Cancel</button>
  </form>;
}
