import { stepLabel } from '../src/core/run-finish';
import { useRef, useState } from 'react';
import { Background, Controls, Position, ReactFlow } from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { ExecutionDetail } from '../src/dashboard-contracts';
import { orderedNodes, providerLabels, ProviderId } from '../src/contracts';
import { phaseDuration } from '../src/core/run-insights';
import { parseVerificationReport } from '../src/core/verification';

const labels = {queued:'Pending',running:'Running',waitingApproval:'Needs your action',succeeded:'Finished',failed:'Failed',cancelled:'Cancelled',interrupted:'Interrupted'};
interface Actions { enabled: boolean; approve: () => void; recover: () => void; control: () => void }
export function RunFlow({detail,clock,enabled,approve,recover,control}: {detail: ExecutionDetail;clock:number} & Actions) {
  const {run,active,memoryReady} = detail;
  const phases = orderedNodes(run.workflow);
  const current = phases.find(node => !run.steps[node.id].skipReason && ['running','waitingApproval','failed','interrupted','cancelled'].includes(run.steps[node.id].status)) ?? phases.find(node => !run.steps[node.id].skipReason && run.steps[node.id].status !== 'succeeded') ?? phases.at(-1)!;
  const focusPhase = useRef<((id:string)=>void) | undefined>(undefined);
  const [selection,setSelection] = useState(current.id);
  const selected = phases.find(node => node.id === selection) ?? current;
  const step = run.steps[selected.id];
  const profile = selected.config.agentSnapshot as {name?:string;id?:string} | undefined;
  const provider = selected.config.provider as ProviderId;
  const nodes = phases.map((node,index) => ({id:node.id,position:{x:index * 235,y:20},sourcePosition:Position.Right,targetPosition:Position.Left,selected:node.id===selected.id,className:`run-node run-node-${run.steps[node.id].status}`,ariaLabel:`${node.label}: ${stepLabel(run.steps[node.id],labels[run.steps[node.id].status])}`,data:{label:<><strong>{index+1}. {node.label}</strong><span>{stepLabel(run.steps[node.id],labels[run.steps[node.id].status])}</span><small>{node.kind==='approval'?'Human approval':providerLabels[node.config.provider as ProviderId] ?? 'Agent'}</small></>}}));
  const edges = (run.workflow.edges ?? []).map(edge => ({id:edge.id,source:edge.source,target:edge.target,className:run.steps[edge.source].status==='succeeded'?'run-edge-complete':'run-edge-pending'}));
  let result = step.output;
  if (selected.config.requireVerification && result) { try { const report = parseVerificationReport(result); result = [report.summary,...report.verification.map(item => typeof item==='string'?item:`${item.command}: ${item.result}${item.limitations?'\nLimitations: '+item.limitations:''}`)].join('\n'); } catch { /* Keep malformed output available for review. */ } }
  const actionable = selected.id===current.id;
  return <section className="run-flow" aria-label="Run flow">
    <p className="muted">Execution snapshot. Select a phase to inspect it; source workflow edits are handled separately. Pan or use the zoom controls to explore the sequence.</p>
    <div className="run-flow-canvas"><ReactFlow nodes={nodes} edges={edges} fitView fitViewOptions={{padding:0.2,minZoom:0.8,maxZoom:1,nodes:[{id:current.id}]}} onInit={instance=>{focusPhase.current=id=>{const index=phases.findIndex(node=>node.id===id);void instance.setCenter(index*235+95,75,{zoom:Math.max(0.8,instance.getZoom())});};}} minZoom={0.2} maxZoom={1.5} nodesFocusable={false} nodesDraggable={false} nodesConnectable={false} edgesReconnectable={false} deleteKeyCode={null} onNodeClick={(_event,node)=>setSelection(node.id)}><Background/><Controls showInteractive={false}/></ReactFlow></div>
    <div className="run-phase-picker" role="group" aria-label="Choose a run phase">{phases.map((node,index)=><button key={node.id} className="secondary" aria-pressed={node.id===selected.id} onClick={()=>{setSelection(node.id);focusPhase.current?.(node.id);}}>{index+1}. {node.label} / {stepLabel(run.steps[node.id],labels[run.steps[node.id].status])}</button>)}</div>
    <section className="run-node-inspector" aria-label="Selected phase details"><h3>{selected.label}</h3><span className="badge">{stepLabel(step,labels[step.status])}</span>
      <dl className="run-facts"><dt>Agent</dt><dd>{selected.kind==='approval'?'Human approval':profile?.name ?? (typeof selected.config.agentId==='string'?selected.config.agentId:'No saved preset')}</dd><dt>Provider / model</dt><dd>{selected.kind==='approval'?'Not applicable':`${providerLabels[provider] ?? provider ?? 'Not recorded'} / ${selected.config.model || 'Provider default'}`}</dd><dt>Duration</dt><dd>{phaseDuration(step.startedAt,step.finishedAt,active?clock:Date.parse(run.updatedAt))}</dd><dt>Access</dt><dd>{selected.kind==='approval'?'Human decision':selected.config.readOnly?'Read-only':'Connector tool approvals apply'}</dd></dl>
      {step.skipReason && <p>Skipped by user: {step.skipReason}. Unverified.</p>}
      {step.activity && <p role="status">{step.activity}</p>}
      {actionable && run.error && <p className="entry-problem">{run.error}</p>}
      {active && step.memoryApproval && <div className="approval-card"><p>{memoryReady?'Required proposals match saved memory. Continue when ready.':'Review required memory proposals before continuing.'}</p><button disabled={!enabled || memoryReady===true} onClick={recover}>Review required memory proposal</button><button disabled={!enabled || memoryReady!==true} onClick={approve}>Continue after memory approval</button></div>}
      {active && step.status==='waitingApproval' && !step.memoryApproval && (selected.kind==='approval'?<button disabled={!enabled} onClick={approve}>Approve and continue</button>:<p>Respond in the open agent question or approval tab. <button disabled={!enabled} onClick={control}>Manage run</button></p>)}
      {actionable && !active && !run.finalization && ['failed','interrupted','cancelled'].includes(run.status) && <button disabled={!enabled} onClick={recover}>{run.story?'Open epic recovery':'Recover run'}</button>}
      {step.liveOutput && <section aria-label="Selected phase latest update"><h4>Latest public update</h4><pre>{step.liveOutput.slice(-1200)}</pre></section>}
      {step.previousOutput && <details><summary>Previous attempt result</summary><pre>{step.previousOutput}</pre></details>}
      {result && <details><summary>Result and verification evidence</summary><pre>{result}</pre></details>}
      <details className="run-context"><summary>Context and usage</summary>{step.context?<><p>Prepared input: {step.context.bytes.toLocaleString()} UTF-8 bytes; approximately {step.context.estimatedTokens.toLocaleString()} tokens.</p><p className="muted">Estimate uses bytes / 4. Covers the assembled instructions and phase prompt, including prior results; excludes native session history, tool results and provider overhead. This is not context-window occupancy.</p><p>{step.context.sources.length} source revisions recorded at this phase attempt's start. Active runs check source freshness; reviewed memory continuation records a new baseline.</p><ul>{step.context.sources.map((source,index)=><li key={source.source+index}><code>{source.source}</code> <span title={source.sha256}>{source.sha256.slice(0,12)}</span></li>)}</ul></>:<p>Prepared context statistics were not recorded for this phase.</p>}
      {step.usage?<p>Provider-reported session usage: {step.usage.inputTokens.toLocaleString()} input / {step.usage.outputTokens.toLocaleString()} output{step.usage.cachedInputTokens!==undefined?` / ${step.usage.cachedInputTokens.toLocaleString()} cached input`:''} tokens. Provider accounting conventions can differ.</p>:<p>Provider token usage is unavailable.</p>}</details>
      <details><summary>Phase instructions and identifiers</summary><pre>{String(selected.config.prompt ?? 'Human approval gate')}</pre><p>Phase: {selected.id}{profile?.id?` / Agent: ${profile.id}`:''}</p>{step.providerSessionId && <p>Provider session: {step.providerSessionId}</p>}</details>
    </section>
    {run.recovery && <p className="muted">{run.recovery.mode==='retry'?'Retry':'Fresh restart'} from phase {run.recovery.fromNodeId} of run <code>{run.recovery.fromRunId}</code>. Earlier snapshots remain separate history.</p>}
  </section>;
}
