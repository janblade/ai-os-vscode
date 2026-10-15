import { FinishRun, FinishRequest } from './finish-run';
import { stepLabel } from '../src/core/run-finish';
import { RunFlow } from './run-flow';
import { useEffect, useState } from 'react';
import { parseVerificationReport, VerificationReport } from '../src/core/verification';
import { ExecutionDetail } from '../src/dashboard-contracts';
export const runLabels = { queued: 'Queued', running: 'Running', waitingApproval: 'Needs approval', succeeded: 'Finished', failed: 'Failed', cancelled: 'Cancelled', interrupted: 'Interrupted' };
export function Execution({ detail, control, review, memory, approve, recover, finish, enabled, taskView = false }: { detail: ExecutionDetail; enabled: boolean; control: () => void; review: () => void; memory: () => void; approve: () => void; recover: () => void; finish: (request:FinishRequest)=>void; taskView?: boolean }) {
  const { run, active, memoryReady } = detail;
  const [clock, setClock] = useState(Date.now());
  const [view,setView] = useState<'Overview'|'Flow'|'Activity'>('Overview');
  const [finishing,setFinishing] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  useEffect(() => { setReviewOpen(false); setFinishing(false); setView('Overview'); }, [run.id]);
  useEffect(() => { if (!active) return; const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, [active]);
  const latest = Math.max(...Object.values(run.steps).map(step => Date.parse(step.lastActivityAt ?? step.startedAt ?? run.updatedAt)));
  const approvalIndex = run.workflow.nodes.findIndex(node => node.kind === 'approval' && run.steps[node.id].status === 'waitingApproval');
  const currentIndex = run.workflow.nodes.findIndex(node => !run.steps[node.id].skipReason && (['running', 'waitingApproval'].includes(run.steps[node.id].status) || !active && ['failed', 'cancelled', 'interrupted'].includes(run.status) && run.steps[node.id].status !== 'succeeded'));
  const current = run.workflow.nodes[currentIndex];
  const next = approvalIndex >= 0 ? run.workflow.nodes[approvalIndex + 1] : undefined;
  const memoryApproval = Object.values(run.steps).find(step => step.memoryApproval)?.memoryApproval;
  const toolApproval = Object.values(run.steps).some(step => step.toolApproval);
  const recent = Object.values(run.steps).filter(step => step.liveOutput || step.activity || step.events?.length).sort((a, b) => Date.parse(b.lastActivityAt ?? run.updatedAt) - Date.parse(a.lastActivityAt ?? run.updatedAt))[0];
  const latestText = recent?.liveOutput?.trim().slice(-1200) || recent?.activity || recent?.events?.at(-1)?.summary;
  let blocked: VerificationReport | undefined;
  if (run.status === 'failed') { const failed = run.workflow.nodes.find(node => run.steps[node.id].status === 'failed' && node.config.requireVerification); if (failed) { try { const report = parseVerificationReport(run.steps[failed.id].output ?? ''); if (report.status === 'blocked') blocked = report; } catch { /* Preserve raw errors for malformed results. */ } } }
  const quiet = Math.max(0, Math.floor((clock - latest) / 1000));
  return <section className="execution" aria-label="Run activity"><h2>Execution</h2>{run.finalization && <p>{run.finalization.command} requested from run {run.finalization.fromRunId.slice(0,8)}. Workflow source opens the original definition; this command is recorded in the snapshot. Task closure is not implied by run success.</p>}<div role="tablist" aria-label="Run views">{(['Overview','Flow','Activity'] as const).map(tab=><button key={tab} id={`run-view-${tab}`} role="tab" aria-selected={view===tab} aria-controls="run-view-panel" onClick={()=>setView(tab)} onKeyDown={event=>{const tabs=['Overview','Flow','Activity'] as const; const index=tabs.indexOf(tab); const target=event.key==='ArrowRight'?tabs[(index+1)%3]:event.key==='ArrowLeft'?tabs[(index+2)%3]:event.key==='Home'?tabs[0]:event.key==='End'?tabs[2]:undefined;if(target){event.preventDefault();setView(target);document.getElementById(`run-view-${target}`)?.focus();}}} tabIndex={view===tab?0:-1}>{tab}</button>)}</div><div id="run-view-panel" role="tabpanel" aria-labelledby={`run-view-${view}`}>
    {view==='Flow'?<RunFlow key={run.id} detail={detail} clock={clock} enabled={enabled} approve={approve} recover={recover} control={control}/>:<>

    <div className="phase-current"><span className="badge">{memoryApproval && active ? 'Waiting for memory approval' : blocked ? 'Blocked' : runLabels[run.status]}</span><h3>{current?.label ?? run.workflow.name}</h3>
      {current && <p>Step {currentIndex + 1} of {run.workflow.nodes.length}</p>}
      {active && run.status !== 'waitingApproval' && <p className="muted">Last observed update {quiet}s ago.{quiet >= 15 ? ' No new provider updates; the run may still be working.' : ''}</p>}
      {memoryApproval && active && <div className="approval-card" role="status"><strong>Memory approval required before this phase can continue</strong><p>{memoryReady ? 'Required proposals match saved memory. You can continue now.' : 'Review and approve the required proposal first. Continue becomes available when all required proposals are applied.'}</p><ul>{memoryApproval.map(file => <li key={file}>{file}</li>)}</ul><button disabled={!enabled || memoryReady === true} onClick={recover}>Review required memory proposal</button>{active && <button disabled={!enabled || memoryReady !== true} onClick={approve}>Continue after memory approval</button>}</div>}
      {active && run.status === 'waitingApproval' && !memoryApproval && <div className="approval-card" role="status"><strong>Your action needed</strong><p>{toolApproval ? 'Waiting for your response - check the VS Code approval or question dialog.' : 'Review the open phase result below, then approve to continue.'}</p>{approvalIndex >= 0 && !toolApproval && <button disabled={!enabled} onClick={approve}>{next ? `Approve and start ${next.label}` : 'Approve workflow result'}</button>}</div>}
      {(blocked || run.error) && <p className="entry-problem" role="alert">{blocked ? blocked.summary : run.error}</p>}
      {!run.finalization && ['interrupted', 'failed', 'cancelled'].includes(run.status) && <div><p>{blocked ? 'Resolve the prerequisites above before retrying this phase. Workflow approval does not apply pending memory proposals.' : 'Inspect partial changes before recovery. A retry starts a new agent session.'}</p><button disabled={!enabled || active} onClick={recover}>{run.story ? 'Open epic recovery' : 'Recover run'}</button>{run.story && <p>Run the current eligible story; its dependencies and approvals are checked again.</p>}</div>}
    </div>
    {run.finalization && !active && run.status !== 'succeeded' && <p>Use Finish early to request another wrap-up or closure with current context. Review pending memory proposals before continuing.</p>}
    {latestText && <section className="latest-update" aria-label="Latest agent update"><h3>Latest update</h3>{Number.isFinite(latest) && <time dateTime={new Date(latest).toISOString()}>{new Date(latest).toLocaleTimeString()}</time>}<pre>{latestText}</pre></section>}
    <ol className="phase-timeline" aria-label="Workflow phases">{run.workflow.nodes.map((node, index) => {
      const step = run.steps[node.id];
      let report: VerificationReport | undefined;
      if (node.config.requireVerification && step.output) { try { report = parseVerificationReport(step.output); } catch { /* Preserve malformed reports for inspection. */ } }
      const expanded = step.status === 'failed' || (active && approvalIndex === index + 1);
      return <li key={node.id}><details key={`${node.id}:${expanded}`} open={expanded} className="phase-row"><summary><span>{index + 1}. {node.label}</span><span className="badge">{stepLabel(step,runLabels[step.status])}</span></summary>{step.skipReason && <p>Skipped by user: {step.skipReason}. No verification was performed.</p>}
        {node.config.readOnly === true && <p className="muted">Read-only step: repository edits are disabled.</p>}
        {step.previousOutput && <details><summary>Previous attempt result</summary><pre>{step.previousOutput}</pre></details>}
        {step.output ? <section aria-label={node.config.requireVerification ? 'Verification report' : 'Phase result'}><pre>{report ? [report.summary, ...report.verification.map(item => typeof item === 'string' ? item : `${item.command}: ${String(item.result)}${item.limitations ? '\nLimitations: ' + item.limitations : ''}`)].join('\n') : step.output}</pre></section> : <p className="muted">{step.status === 'queued' ? 'This phase has not started.' : step.status === 'waitingApproval' ? 'Waiting for your response.' : step.status === 'running' ? 'Result will appear when this phase finishes.' : 'No result was recorded.'}</p>}
      </details></li>;
    })}</ol>
    </>}
    </div>
    <div className="detail-actions">{!run.story && <button className="secondary" disabled={!enabled} onClick={()=>setFinishing(!finishing)} aria-expanded={finishing}>Finish early...</button>}<button className="secondary" onClick={control}>{active ? 'Manage / cancel run' : 'Inspect run'}</button><button className="secondary" disabled={!enabled} onClick={() => taskView ? review() : setReviewOpen(!reviewOpen)} aria-expanded={taskView ? undefined : reviewOpen}>{taskView ? 'Go to Review' : 'Review results'}</button></div>
    {finishing && <FinishRun key={run.id} run={run} active={active} enabled={enabled} submit={finish} cancel={()=>setFinishing(false)}/>}
    {!taskView && reviewOpen && <section aria-label="Review results"><p>Workflow approval does not accept repository changes or complete the task.</p><div className="detail-actions"><button disabled={active || !enabled} onClick={review}>Review repository changes</button><button className="secondary" disabled={!enabled} onClick={memory}>Review memory proposals</button></div>{active && <p>Finish or cancel this run before reviewing repository changes.</p>}{run.review && <p>Acceptance recorded: {new Date(run.review.acceptedAt).toLocaleString()}. New changes require a fresh review.</p>}</section>}
    <details key={view} open={view==='Activity' ? true : undefined} className="execution-details"><summary>Details: transcript, event log and identifiers</summary><p className="source-root">Run ID: {run.id}</p>{run.recovery && <p>Recovery: {run.recovery.mode === 'retry' ? 'Retry from phase' : 'Fresh run after phase'} {run.recovery.fromNodeId}. Previous run: {run.recovery.fromRunId}</p>}
      {run.workflow.nodes.map(node => { const step = run.steps[node.id]; return <details key={node.id}><summary>{node.label}</summary>{step.providerSessionId && <p className="source-root">Provider session: {step.providerSessionId}</p>}{step.activity && <p>{step.activity}</p>}{step.events?.length ? <ul className="activity-trail" aria-label="Recent agent activity">{[...step.events].reverse().map((event, index) => <li key={event.at + ':' + index}><time dateTime={event.at}>{new Date(event.at).toLocaleTimeString()}</time> {event.summary}</li>)}</ul> : null}{step.liveOutput && <pre>{step.liveOutput}</pre>}</details>; })}
      {run.review && <details><summary>Verification and review receipt</summary><pre>{run.review.verification}{'\n\n'}{run.review.findings}</pre></details>}
      <p className="muted">Native side effects are never replayed automatically. Run success is execution status only.</p>
    </details>
  </section>;
}
