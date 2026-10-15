import { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DashboardAction, DashboardEntry, DashboardMessage, DashboardState, DashboardPage, RecoveryPrompt, CreationDraft, dashboardPages, dashboardOperations } from '../src/dashboard-contracts';
import { TaskWorkspace, TaskTab } from './task-workspace';
import { taskList, byRecency, repositoryLabel } from '../src/core/task-ux';
import { Execution, runLabels } from './execution';
import { LifecycleForm, LifecycleDraft } from './lifecycle-form';
import { ExecutionDetail } from '../src/dashboard-contracts';
import { CreationForm } from './creation-form';
import { TaskDraft, TaskForm } from './task-form';
import './style.css';
import './dashboard.css';
declare function acquireVsCodeApi(): { postMessage(message: DashboardMessage): void };
const host = acquireVsCodeApi();
const initialPage = (dashboardPages as readonly string[]).includes(document.body.dataset.page ?? '') ? document.body.dataset.page as DashboardPage : 'task';
const pageLabels = { task: 'Tasks', epic: 'Epics', agent: 'Agents', memory: 'Memory', workflow: 'Workflows', repository: 'Repositories', run: 'Runs' };
const descriptions = { epic: 'Inspect rollout stories, acceptance criteria and dependencies. Run the next eligible story using a reusable workflow.', agent: 'Save reusable instruction presets and select them for tasks or workflow steps. Choose Claude Code, Codex, or local mock execution.', task: 'Manage working notes, task states and session handoffs.', memory: 'Browse project knowledge, plans, decisions and reusable workflows.', workflow: 'Open a workflow canvas or create a reviewed sequence of steps.', repository: 'Inspect workspace repositories and their existing configuration.', run: 'Inspect saved runs and manage approval, cancellation or resuming.' };
const emptyHints = { task: 'Create a task to record an outcome, link a repository, and choose a workflow when ready.', epic: 'Select a task and use Copy epic planning prompt. Saved plans marked Type: epic appear here.', agent: 'Create an agent preset or register a framework template, then select it in a task or workflow.', memory: 'Task notes, plans, decisions and proposed amendments appear here from the selected framework.', workflow: 'Create a workflow, edit its steps in the canvas, then launch it from a linked task.', repository: 'Add a local repository folder to the VS Code workspace to make it available here.', run: 'Start a workflow from a task or the workflow canvas. Its activity and results will appear here.' };
const labels = { open: 'Open', inProgress: 'In progress', done: 'Done', unbound: 'Not linked', invalid: 'Needs repair' };
function App() {
  const [recovery,setRecovery] = useState<RecoveryPrompt>();
  const recoveryReply = useRef<string | undefined>(undefined);
  const [recoverySubmitting,setRecoverySubmitting] = useState(false);
  const recoveryPanel = useRef<HTMLElement | null>(null);
  useEffect(()=>{if(recovery){recoveryPanel.current?.scrollIntoView({block:'nearest'});recoveryPanel.current?.querySelector<HTMLButtonElement>('[data-cancel]')?.focus();}},[recovery?.requestId]);
  const [operation, setOperation] = useState<{ id: string; label: string }>();
  const operationRef = useRef<{ id: string; label: string } | undefined>(undefined);
  const post = (message: DashboardMessage) => {
    const label = dashboardOperations[message.type];
    if (label) {
      if (operationRef.current) return;
      const pending = { id: crypto.randomUUID(), label };
      operationRef.current = pending; setOperation(pending);
      host.postMessage({ ...message, operationId: pending.id });
    } else host.postMessage(message);
  };
  const [state, setState] = useState<DashboardState>();
  const [tab, setTab] = useState<DashboardPage>(initialPage);
  const currentPage = useRef<DashboardPage>(initialPage);
  const [showArchived, setShowArchived] = useState(false);
  const [formGeneration, setFormGeneration] = useState(0);
  const [creation, setCreation] = useState<CreationDraft>();
  const creationRef = useRef<CreationDraft | undefined>(undefined);
  const [creating, setCreating] = useState(false);
  const [draft, setDraft] = useState<TaskDraft>();
  const draftRef = useRef<TaskDraft | undefined>(undefined);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selected, setSelected] = useState<DashboardEntry>();
  const [execution, setExecution] = useState<ExecutionDetail>();
  const [lifecycle, setLifecycle] = useState<LifecycleDraft>();
  const lifecycleRef = useRef<LifecycleDraft | undefined>(undefined);
  const [detail, setDetail] = useState<{ content: string; unsaved?: boolean; problem?: string }>();
  const currentState = useRef<DashboardState | undefined>(undefined);
  const selection = useRef<string | undefined>(undefined);
  const [taskTab, setTaskTab] = useState<TaskTab>('Overview');
  const [dirty, setDirty] = useState(false); const dirtyRef = useRef(false);
  const dirtyChange = useCallback((value: boolean) => { dirtyRef.current = value; setDirty(value); }, []);
  const focusBeforeLeave = useRef<HTMLElement | null>(null);
  const [pendingLeave, setPendingLeave] = useState<(() => void)>();
  const clearForms = () => {
    if (creationRef.current) post({ type: 'cancelCreation', requestId: creationRef.current.requestId });
    creationRef.current = undefined; setCreation(undefined); setCreating(false); draftRef.current = undefined; setDraft(undefined); lifecycleRef.current = undefined; setLifecycle(undefined); dirtyChange(false);
  };
  const leave = (next: () => void) => {
    if (dirtyRef.current) { focusBeforeLeave.current = document.activeElement as HTMLElement; setPendingLeave(() => () => { clearForms(); next(); }); return; }
    clearForms(); next();
  };
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const message = event.data;
      if (message.type==='recoveryPrompt') {setRecovery(message);recoveryReply.current=undefined;setRecoverySubmitting(false);}
      if (message.type==='recoveryClosed') setRecovery(current=>current?.requestId===message.requestId?undefined:current);
      if (message.type === 'operationComplete' && message.operationId === operationRef.current?.id) { operationRef.current = undefined; setOperation(undefined); }
      if (message.type === 'navigate' && operationRef.current) return;
      if (message.type === 'navigate' && (dashboardPages as readonly string[]).includes(message.page)) {
        if (message.page !== currentPage.current) {
          const navigate = () => { currentPage.current = message.page; setTab(message.page); setFilter('all'); setQuery(''); selection.current = undefined; setSelected(undefined); setDetail(undefined); setExecution(undefined); setTaskTab('Overview'); post({ type: 'navigate', page: message.page }); };
          if (dirtyRef.current) { leave(navigate); post({ type: 'navigate', page: currentPage.current }); return; }
          clearForms(); navigate();
        }
        post({ type: 'navigate', page: currentPage.current });
      }
      if (message.type === 'dashboard') {
        if (currentState.current?.root !== message.root) { draftRef.current = undefined; setDraft(undefined); }
        if (currentState.current?.root !== message.root) { selection.current = undefined; setSelected(undefined); setDetail(undefined); setExecution(undefined); }
        if (currentState.current?.root !== message.root) { lifecycleRef.current = undefined; setLifecycle(undefined); dirtyChange(false); setPendingLeave(undefined); }
        currentState.current = message;
        setState(message);
        setSelected(message.entries.find((entry: DashboardEntry) => entry.id === selection.current));
      }
      if (message.type === 'selectEntry' && currentState.current?.root === message.root && currentState.current?.revision === message.revision && currentState.current?.entries.some(entry => entry.id === message.id)) leave(() => {
        const current = currentState.current; const entry = current?.entries.find(entry => entry.id === message.id); if (!current || !entry || current.root !== message.root) return;
        currentPage.current = entry.kind; setTab(entry.kind); setFilter('all'); setQuery(''); selection.current = entry.id; setSelected(entry); setDetail(undefined); setExecution(undefined); setTaskTab('Overview');
        post({ type: 'select', id: entry.id, revision: current.revision });
      });
      if (message.type === 'execution' && selection.current === message.id && currentState.current?.revision === message.revision) setExecution(message.run ? { run: message.run, active: message.active, memoryReady: message.memoryReady } : undefined);
      if (['reviewDraft', 'epicDraft', 'handoffDraft'].includes(message.type) && selection.current === message.id && currentState.current?.root === message.root) { const next = { ...message, kind: message.type === 'reviewDraft' ? 'review' : message.type === 'epicDraft' ? 'epic' : 'handoff' }; lifecycleRef.current = next; setLifecycle(next); dirtyChange(false); setTaskTab(next.kind === 'review' ? 'Review' : 'Overview'); }
      if (['reviewSaved', 'epicSaved', 'handoffSaved'].includes(message.type) && selection.current === message.id) { lifecycleRef.current = undefined; setLifecycle(undefined); dirtyChange(false); }
      if (message.type === 'detail' && selection.current === message.id && currentState.current?.revision === message.revision) setDetail(message);
      if (message.type === 'taskDraft' || message.type === 'taskSaved') {
        if (currentState.current?.root === message.root && selection.current === message.id) {
          if (message.type === 'taskSaved' && !draftRef.current) return;
          if (message.type === 'taskDraft') { setFormGeneration(value => value + 1); dirtyChange(false); setTaskTab('Notes'); }
          draftRef.current = message; setDraft(message);
        }
      }
      if (message.type === 'creationDraft' && currentState.current?.root === message.root) {
        if (draftRef.current || lifecycleRef.current || (creationRef.current && creationRef.current.requestId !== message.requestId)) {
          setError('Close the current form before creating another entry.'); post({ type: 'cancelCreation', requestId: message.requestId }); return;
        }
        if (creationRef.current?.requestId !== message.requestId) {
          creationRef.current = message; setCreation(message); setCreating(false);
          currentPage.current = message.kind; setTab(message.kind); setFilter('all'); setQuery(''); setShowArchived(false);
          selection.current = undefined; setSelected(undefined); setDetail(undefined); setExecution(undefined);
          post({ type: 'navigate', page: message.kind });
        }
      }
      if (message.type === 'taskPrepared' && creationRef.current?.requestId === message.requestId && creationRef.current?.root === message.root) {
        const next = { ...creationRef.current!, prepared: message.prepared }; creationRef.current = next; setCreation(next); setCreating(false);
      }
      if (message.type === 'creationCancelled' && creationRef.current?.requestId === message.requestId) { creationRef.current = undefined; setCreation(undefined); setCreating(false); }
      if (message.type === 'creationSaved' && creationRef.current?.requestId === message.requestId && creationRef.current?.root === message.root) {
        creationRef.current = undefined; setCreation(undefined); setCreating(false); dirtyChange(false); selection.current = message.id; setDetail(undefined);
      }
      if (message.type === 'notice') setNotice(message.message);
      if (message.type === 'error') { setError(message.message); setCreating(false); }
    };
    window.addEventListener('message', listener); post({ type: 'action', action: 'refresh' }); post({ type: 'navigate', page: initialPage });
    return () => window.removeEventListener('message', listener);
  }, []);
  const action = (action: DashboardAction) => { setError(''); setNotice(''); post({ type: 'action', action }); };
  const itemAction = (type: 'select' | 'open' | 'properties' | 'park' | 'resume' | 'editTask' | 'manageTaskRun' | 'useTemplate' | 'planEpic' | 'runTask' | 'reviewChanges' | 'reviewProposal' | 'editEpic' | 'saveHandoff' | 'controlRun' | 'completeTask' | 'linkRepository' | 'approveRun' | 'recoverRun', entry: DashboardEntry) => {
    if (state) { setError(''); setNotice(''); post({ type, id: entry.id, revision: state.revision }); }
  };
  const entries = state?.entries.filter(entry => entry.kind === tab) ?? [];
  const filteredEntries = entries.filter(entry => (tab !== 'task' || Boolean(entry.archived) === showArchived) && (tab === 'task' || filter === 'all' || entry.category === filter) &&
    [entry.title, entry.id, entry.repository, entry.category, entry.status].join(' ').toLowerCase().includes(query.toLowerCase()));
  const visible = tab === 'task' ? taskList(filteredEntries, filter) : filteredEntries.sort(byRecency);
  const filters = tab === 'task' ? [['attention', 'Needs attention'], ['running', 'Running'], ['recent', 'Recent'], ...Object.entries(labels)] : [...new Set(entries.map(entry => entry.category))].map(value => [value, tab === 'run' ? runLabels[value as keyof typeof runLabels] ?? value : value]);
  return <main>
    {operation && <p className="operation-status" role="status">{recovery ? (recovery.message==='Finish early'?'Review the finish action below. No action has started.':'Review recovery options below. No new agent has started.') : <><span className="operation-spinner" aria-hidden="true" />{operation.label}... Complete or cancel the pending action.</>}</p>}
    {recovery && <section ref={recoveryPanel} className="inline-recovery" aria-label={recovery.message==='Finish early'?'Finish action review':'Run recovery'} aria-busy={recoverySubmitting}><h2>{recovery.message}</h2><pre>{recovery.detail}</pre>{recovery.review && <details><summary>Review changes and previous results</summary><pre>{recovery.review}</pre></details>}<div className="detail-actions">{recovery.choices.map((choice,index)=><button key={index} disabled={recoverySubmitting} onClick={()=>{if(recoveryReply.current===recovery.requestId)return;recoveryReply.current=recovery.requestId;setRecoverySubmitting(true);host.postMessage({type:'answerRecovery',requestId:recovery.requestId,choice:index});}}>{choice}</button>)}<button data-cancel className="secondary" disabled={recoverySubmitting} onClick={()=>{if(recoveryReply.current===recovery.requestId)return;recoveryReply.current=recovery.requestId;setRecoverySubmitting(true);host.postMessage({type:'answerRecovery',requestId:recovery.requestId,choice:null});}}>{recovery.message==='Finish early'?'Cancel finish action':'Cancel recovery'}</button></div>{recoverySubmitting && <p role="status">{recovery.message==='Finish early'?'Checking finish action...':'Checking recovery...'}</p>}</section>}
    <fieldset className="operation-controls" disabled={Boolean(operation)} aria-busy={Boolean(operation)}><legend className="sr-only">Dashboard controls</legend>
    <header><div><p className="eyebrow">AI OS / WORKSPACE</p><h1>{pageLabels[tab]}</h1><p className="muted">{descriptions[tab]}</p></div><button className="secondary" onClick={() => action('refresh')}>Refresh</button></header>
    {!state ? <p role="status">Loading workspace...</p> : <>
      <details className="framework-location"><summary>Framework location</summary><p className="source-root">{state.root || 'No framework selected'}</p></details>
      {!state.trusted && <p className="notice" role="status">Restricted mode: browsing only. Trust the workspace to create tasks or prepare handoffs.</p>}
      {state.problem && <p className="notice" role="status">{state.problem}</p>}
      {error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}
      {pendingLeave && <div className="discard-backdrop"><div onKeyDown={event => { if (event.key === 'Escape') { setPendingLeave(undefined); focusBeforeLeave.current?.focus(); } if (event.key === 'Tab') { const buttons = event.currentTarget.querySelectorAll<HTMLButtonElement>('button'); const first = buttons[0], last = buttons[buttons.length - 1]; if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); } } }} role="alertdialog" aria-modal="true" aria-labelledby="discard-title" className="discard-dialog"><h2 id="discard-title">Discard unsaved changes?</h2><p>Saved files stay intact. Only the current unsaved form will be discarded.</p><div className="detail-actions"><button autoFocus onClick={() => { setPendingLeave(undefined); focusBeforeLeave.current?.focus(); }}>Keep editing</button><button className="secondary" onClick={() => { const next = pendingLeave; setPendingLeave(undefined); next(); }}>Discard changes</button></div></div></div>}
      <section className="toolbar" aria-label="Workspace actions">
        {(tab === 'task' || tab === 'workflow' || tab === 'agent') && <button disabled={!state.trusted || !state.root || Boolean(draft) || Boolean(creation) || Boolean(lifecycle)} onClick={() => action(tab === 'agent' ? 'createAgent' : tab === 'workflow' ? 'createWorkflow' : 'createTask')}>{tab === 'agent' ? 'Create agent' : tab === 'workflow' ? 'Create workflow' : 'Create task'}</button>}
        {tab === 'task' && <button className="secondary" disabled={!state.trusted || !state.root || Boolean(draft) || Boolean(creation) || Boolean(lifecycle)} onClick={() => action('adoptTask')}>Adopt existing task</button>}
        {!state.root && <><button disabled={!state.trusted} onClick={() => action('selectFramework')}>Select framework</button><button disabled={!state.trusted} onClick={() => action('initialize')}>Initialize workspace</button></>}
        <input className="dashboard-search" aria-label="Search titles, paths and repositories" placeholder="Search titles, paths and repositories..." value={query} onChange={event => setQuery(event.target.value)} />
        {tab === 'task' && <label className="archive-filter"><input type="checkbox" checked={showArchived} onChange={event => setShowArchived(event.target.checked)} />Archived tasks</label>}
        <select aria-label="Filter entries" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All {tab === 'task' ? 'states' : 'categories'}</option>{filters.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
      </section>
      <div className="dashboard-grid">
        <section className="dashboard-list" aria-label="Entries"><p className="muted">{visible.length} of {entries.length} entries</p>
          {!visible.length && <div className="empty"><h2>{entries.length && (query || filter !== 'all') ? 'No matching entries' : tab === 'task' ? showArchived ? 'No archived tasks' : 'No active tasks' : `No ${pageLabels[tab].toLowerCase()} yet`}</h2><p>{entries.length && (query || filter !== 'all') ? 'Adjust your search or filters to show entries.' : tab === 'task' && showArchived ? 'Archived tasks appear here. Uncheck Archived tasks to return to active work.' : emptyHints[tab]}</p>{(query || filter !== 'all') && <button className="secondary" onClick={() => { setQuery(''); setFilter('all'); setShowArchived(false); }}>Clear search and filters</button>}</div>}
          {visible.map(entry => <button key={entry.id} className={`entry-card secondary ${selected?.id === entry.id ? 'selected' : ''}`} aria-pressed={selected?.id === entry.id} onClick={() => { if (selection.current === entry.id) return; leave(() => { selection.current = entry.id; setSelected(entry); setDetail(undefined); setExecution(undefined); setTaskTab('Overview'); itemAction('select', entry); }); }}>
            <strong>{entry.title}</strong>{entry.archived && <span className="badge">Archived</span>}{entry.kind === 'task' ? <><span className="badge">Task: {entry.status ? labels[entry.status] : 'Not linked'}</span><span className="task-subtitle">Execution: {entry.activity ?? 'Not started'}</span>{entry.subtitle && entry.runId && <span className="task-subtitle">{entry.subtitle}</span>}{entry.runId && entry.progress !== undefined && <><progress max={100} value={entry.progress} aria-label={entry.progressLabel ?? 'Workflow steps'} /><small>Workflow steps: {entry.progressLabel}</small></>}{entry.updatedAt && Number.isFinite(Date.parse(entry.updatedAt)) && <small>Updated: {new Date(entry.updatedAt).toLocaleString()}</small>}<small>Review: {entry.reviewRecorded ? 'Acceptance recorded' : entry.runId ? 'Not accepted' : 'No run to review'}</small><small title={entry.repository}>{repositoryLabel(entry.repository)}</small></> : <><span className="badge">{entry.epic ? entry.epic.derivedStatus ?? entry.epic.status : entry.kind === 'run' ? runLabels[entry.category as keyof typeof runLabels] ?? entry.category : entry.category}</span>{entry.kind !== 'run' && entry.subtitle && <span className="task-subtitle">{entry.subtitle}</span>}{entry.epic && <><progress max={entry.epic.total} value={entry.epic.completed} aria-label="Epic completion" /><small>{entry.epic.completed} of {entry.epic.total} stories complete</small></>}{entry.kind === 'run' && <><span className="task-subtitle">{entry.subtitle ?? (entry.category === 'waitingApproval' ? 'Needs your approval or response' : entry.category === 'running' ? 'Waiting for provider activity' : 'Inspect phase output and results')}</span>{entry.updatedAt && <small>Last update: {new Date(entry.updatedAt).toLocaleString()}</small>}</>}<small>{entry.repository ?? entry.id}</small></>}{entry.problem && <span className="entry-problem">{entry.problem}</span>}
          </button>)}
        </section>
        <aside aria-label="Entry details">{creation ? <CreationForm key={creation.requestId} draft={creation} enabled={state.trusted && state.root === creation.root} busy={creating} onDirtyChange={dirtyChange} post={message => { setError(''); setNotice(''); setCreating(true); post(message); }} cancel={() => leave(() => setError(''))} /> : !selected ? <><p className="eyebrow">DETAILS</p><h2>Select an entry</h2><p>{emptyHints[tab]}</p></> : selected.kind === 'task' ? <TaskWorkspace key={selected.id} entry={selected} entries={state.entries} execution={execution} trusted={state.trusted} tab={taskTab} setTab={setTaskTab} busy={Boolean(draft || lifecycle)} dirty={dirty} detail={detail}
          act={type => { if (type === 'editTask' && draft) { leave(() => itemAction(type, selected)); } else itemAction(type, selected); }}
          finish={request=>{if(state && selected)post({type:'finishRun',id:selected.id,revision:state.revision,...request});}} adopt={() => itemAction('linkRepository', selected)} openEpic={epic => leave(() => { currentPage.current = 'epic'; setTab('epic'); setFilter('all'); setQuery(''); selection.current = epic.id; setSelected(epic); setDetail(undefined); setExecution(undefined); post({ type: 'navigate', page: 'epic' }); itemAction('select', epic); })}
          memory={() => leave(() => { currentPage.current = 'memory'; setTab('memory'); setFilter('Memory proposals'); setQuery(''); selection.current = undefined; setSelected(undefined); setDetail(undefined); setExecution(undefined); post({ type: 'navigate', page: 'memory' }); })}
          lifecycleKind={lifecycle?.kind}
          lifecycle={lifecycle && <LifecycleForm key={lifecycle.kind + ':' + lifecycle.token} draft={lifecycle} revision={state.revision} enabled={state.trusted && state.root === lifecycle.root} onDirtyChange={dirtyChange} post={message => { setError(''); setNotice(''); post(message); }} close={() => leave(() => {})} />}
          editor={draft && <TaskForm key={draft.id + ':' + formGeneration} draft={draft} revision={state.revision} trusted={state.trusted} reload={() => leave(() => itemAction('editTask', selected))} onDirtyChange={dirtyChange} post={message => { setError(''); setNotice(''); post(message); }} close={() => leave(() => {})} />}
        /> : <>
          <p className="eyebrow">{selected.kind === 'run' ? runLabels[selected.category as keyof typeof runLabels] ?? selected.category : selected.category}</p><h2>{selected.title}</h2><p className="source-root">{selected.id}</p>{selected.repository && <p className="source-root">{selected.repository}</p>}
          {selected.epic && <section className="epic-stories" aria-label="Epic stories"><p>{selected.epic.derivedStatus ?? selected.epic.status} - {selected.epic.completed} of {selected.epic.total} stories complete</p><progress max={selected.epic.total} value={selected.epic.completed} aria-label="Epic story progress" />{selected.epic.derivedStatus && selected.epic.derivedStatus !== selected.epic.status && <p className="muted">Source header says {selected.epic.status}; displayed status is derived from story progress. Update the source roll-up after verification.</p>}<p className="muted">Task: {selected.epic.task ?? 'No task linked'}. Run completion does not mark a story done.</p>{selected.epic.stories.map(story => <article key={story.id} className="epic-story"><h3>Story {story.number}: {story.title}</h3><p>{story.status} - Steps {story.steps.done}/{story.steps.total} - Acceptance {story.acceptance.done}/{story.acceptance.total}</p><p className="muted">Depends on: {story.dependencies.length ? story.dependencies.map(number => `Story ${number}`).join(', ') : 'None'}</p>{story.blocked && <p>{story.blocked}</p>}<details><summary>Story details</summary><pre>{story.content}</pre></details>{story.run && <p>Latest run: {runLabels[story.run.status as keyof typeof runLabels] ?? story.run.status} <button className="secondary" onClick={() => post({ type: 'manageStoryRun', id: selected.id, revision: state.revision, storyId: story.id, sha256: selected.epic!.sha256 })}>Manage story run</button></p>}<button disabled={!state.trusted || Boolean(detail?.unsaved) || Boolean(lifecycle) || Boolean(draft) || Boolean(story.run?.active) || Boolean(story.blocked) || !selected.epic!.task || Boolean(selected.problem)} onClick={() => post({ type: 'runStory', id: selected.id, revision: state.revision, storyId: story.id, sha256: selected.epic!.sha256 })}>Run this story</button>{!story.blocked && (story.run?.active || !selected.epic!.task || detail?.unsaved || lifecycle || draft) && <p className="muted">{story.run?.active ? 'Finish or cancel this story run before starting another.' : !selected.epic!.task ? 'Link this epic to a task before running a story.' : detail?.unsaved ? 'Save the epic source before running a story.' : 'Close the current form before running a story.'}</p>}</article>)}</section>}
          {execution && <Execution finish={request=>post({type:'finishRun',id:selected.id,revision:state.revision,...request})} recover={() => itemAction('recoverRun', selected)} enabled={state.trusted && !lifecycle && !draft && !creation} detail={execution} approve={() => itemAction('approveRun', selected)} control={() => itemAction('controlRun', selected)} review={() => itemAction('reviewChanges', selected)} memory={() => { currentPage.current = 'memory'; setTab('memory'); setFilter('Memory proposals'); setQuery(''); selection.current = undefined; setSelected(undefined); setDetail(undefined); setExecution(undefined); post({ type: 'navigate', page: 'memory' }); }} />}
          {selected.proposal && <section aria-label="Memory proposal review"><h3>Proposed memory change</h3><p><strong>Target:</strong> {selected.proposal.target}</p><p>{selected.proposal.reason}</p><p>Use Review and approve proposal below. After validation and review, the confirmation dialog offers Approve proposal. Nothing changes until you confirm.</p></section>}
          {selected.category === 'Proposal support files' && <p>This is supporting evidence, a receipt, or an invalid proposal. It cannot be approved as a memory change. Select a valid entry under Memory proposals.</p>}
          {selected.kind === 'agent' && <p className="muted">{selected.template ? 'Create a registered agent from this template before assigning it to tasks or workflows.' : 'Use this registered or legacy profile as a task default or workflow agent. Runs preserve its launch snapshot.'}</p>}
          <div className="detail-actions">{selected.kind === 'epic' && <button disabled={!state.trusted || Boolean(selected.problem) || Boolean(lifecycle)} onClick={() => itemAction('editEpic', selected)}>Edit and review epic</button>}{selected.proposal && <button disabled={!state.trusted} onClick={() => itemAction('reviewProposal', selected)}>Review and approve proposal</button>}{selected.kind === 'agent' && selected.template && <button disabled={!state.trusted || Boolean(selected.problem)} onClick={() => itemAction('useTemplate', selected)}>Use template</button>}{!(selected.kind === 'run' && execution) && <button onClick={() => itemAction('open', selected)}>{selected.kind === 'agent' ? 'Edit configuration' : selected.kind === 'workflow' ? 'Open workflow' : selected.kind === 'epic' ? 'Edit epic source' : selected.kind === 'memory' ? 'Open read-only source' : selected.kind === 'run' ? 'Manage run' : selected.kind === 'repository' ? 'Reveal repository' : 'Open task notes'}</button>}
            {selected.properties && <button className="secondary" onClick={() => itemAction('properties', selected)}>Open properties</button>}

          </div>
          {lifecycle && lifecycle.id === selected.id && <LifecycleForm key={lifecycle.kind + ':' + lifecycle.token} draft={lifecycle} revision={state.revision} enabled={state.trusted && state.root === lifecycle.root} onDirtyChange={dirtyChange} post={message => { setError(''); setNotice(''); post(message); }} close={() => leave(() => {})} />}
          {draft && draft.id === selected.id && <TaskForm key={draft.id + ':' + formGeneration} draft={draft} revision={state.revision} trusted={state.trusted} post={message => { setError(''); setNotice(''); post(message); }} close={() => { draftRef.current = undefined; setDraft(undefined); }} />}
          {selected.problem && <p role="alert">{selected.problem}</p>}
          {!detail ? <p role="status">Loading preview...</p> : detail.problem ? <p role="alert">{detail.problem} Open the source to inspect it.</p> : <>{detail.unsaved && <p className="notice">Preview includes unsaved editor changes.</p>}{['run', 'workflow', 'agent', 'epic'].includes(selected.kind) ? <details><summary>{selected.kind === 'run' ? 'Run snapshot' : 'Source preview'}</summary><pre className="source-preview">{detail.content || '(Empty file)'}</pre></details> : <pre className="source-preview">{detail.content || '(Empty file)'}</pre>}</>}
        </>}</aside>
      </div>
    </>}
    </fieldset>
  </main>;
}
createRoot(document.getElementById('root')!).render(<App />);
