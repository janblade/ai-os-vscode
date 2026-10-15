import { useEffect, useRef, useState } from 'react';
import { CreationDraft, DashboardMessage } from '../src/dashboard-contracts';
import { ProviderId, NativeProviderId, providers, providerLabels } from '../src/contracts';

export function CreationForm({ draft, enabled, busy, post, cancel, onDirtyChange }: {
  draft: CreationDraft; enabled: boolean; busy: boolean; post: (message: DashboardMessage) => void; cancel: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [mode, setMode] = useState<'prompt' | 'form'>('form');
  const [prompt, setPrompt] = useState('');
  const originalInput = useRef({ title: '', notes: '' });
  const [review, setReview] = useState(false);
  const [title, setTitle] = useState(draft.template?.name ?? '');
  const [repository, setRepository] = useState(draft.repositories.length === 1 ? '0' : '');
  const [agentId, setAgentId] = useState('');
  const [notes, setNotes] = useState('');
  const [provider, setProvider] = useState<ProviderId | ''>(draft.template?.provider ?? (draft.kind === 'agent' ? '' : 'codex'));
  const [model, setModel] = useState(draft.template?.model ?? '');
  const [instructions, setInstructions] = useState(draft.instructions);
  const task = draft.kind === 'task';
  const dirty = review || Boolean(prompt || notes || title !== (draft.template?.name ?? '') || instructions !== draft.instructions || model !== (draft.template?.model ?? '') || agentId || repository !== (draft.repositories.length === 1 ? '0' : '') || provider !== (draft.template?.provider ?? (draft.kind === 'agent' ? '' : 'codex')));
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { if (draft.prepared) { setTitle(draft.prepared.title); setNotes(draft.prepared.notes); setReview(true); } }, [draft.prepared?.id]);
  return <section className="task-form" aria-label={task ? 'Create task' : 'Create agent'}>
    <p className="eyebrow">NEW {task ? 'TASK' : 'AGENT'}</p><h2>{task ? review ? 'Review task draft' : 'Create task' : 'Create agent'}</h2>
    <p className="muted">{task ? 'Use a prompt or form fields. An agent prepares the same task structure for review before filing.' : 'Save a reusable configuration for tasks and workflow steps. Native provider login stays in its client.'}</p>
    {draft.template && <p className="muted">Based on {draft.template.name}. Its role, skill selection and execution constraints are preserved. This creates a separate registered profile.</p>}
    {!enabled && <p role="alert">The workspace is restricted or the framework changed. Cancel and reopen this form in the intended framework.</p>}
    <form onSubmit={event => {
      event.preventDefault();
      if (task && !review) { originalInput.current = { title, notes }; post({ type: 'prepareTask', requestId: draft.requestId, description: mode === 'prompt' ? prompt : notes, ...(mode === 'form' ? { title } : {}), repository: Number(repository), provider: provider as NativeProviderId }); }
      else if (task) post({ type: 'createTask', requestId: draft.requestId, draftId: draft.prepared!.id, title, repository: Number(repository), notes, ...(agentId ? { agentId } : {}) });
      else post({ type: 'createAgent', requestId: draft.requestId, name: title, provider, model, instructions });
    }}>
      <fieldset disabled={!enabled || busy}>
        {task && !review && <div className="detail-actions" role="group" aria-label="Task creation method"><button type="button" className="secondary" aria-pressed={mode === 'prompt'} onClick={() => setMode('prompt')}>Via prompt</button><button type="button" className="secondary" aria-pressed={mode === 'form'} onClick={() => setMode('form')}>Via form</button></div>}
        {task && !review && mode === 'prompt' ? <label>Task prompt<textarea autoFocus required maxLength={200000} rows={10} value={prompt} onChange={event => setPrompt(event.target.value)} placeholder="Describe the ticket, desired outcome, known evidence and constraints" /></label> : <label>{task ? 'Task title' : 'Agent name'}<input autoFocus required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>}
        {task ? <>
          <label>Repository<select disabled={review} required value={repository} onChange={event => setRepository(event.target.value)}><option value="">Choose a repository</option>{draft.repositories.map((entry, index) => <option key={index} value={String(index)}>{entry.label}</option>)}</select></label>
          {!draft.repositories.length && <p role="alert">Add a local repository folder to this workspace before creating a task.</p>}
          <label>Default agent<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">No default agent</option>{draft.agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({agent.provider ?? 'workflow provider'})</option>)}</select></label>
          {(review || mode === 'form') && <label>{review ? 'Draft notes' : 'Initial notes'}<textarea rows={14} maxLength={200000} value={notes} onChange={event => setNotes(event.target.value)} placeholder="Ticket, evidence, scope and next steps" /></label>}
          {!review && <><label>Drafting provider<select value={provider} onChange={event => setProvider(event.target.value as ProviderId)}>{providers.filter(item => item !== 'mock').map(item => <option key={item} value={item}>{providerLabels[item]}</option>)}</select></label><p className="muted">Gemini/Copilot require their signed-in CLIs; file edits require approval, and shell execution is unavailable.</p><p className="muted">Preparing a draft sends your input to the selected signed-in provider and uses its model allowance. No task file is created until Save task.</p></>}
          {review && <p role="status">Review the agent draft and correct assumptions before saving. The task has not been filed yet.</p>}
        </> : <>
          <label>Provider preference<select value={provider} onChange={event => setProvider(event.target.value as ProviderId)}><option value="">Inherit workflow provider</option>{providers.filter(item => item !== 'mock').map(item => <option key={item} value={item}>{providerLabels[item]}</option>)}<option value="mock">Mock (local test)</option></select></label>
          <label>Model (optional)<input maxLength={200} value={model} onChange={event => setModel(event.target.value)} placeholder="Native default" /></label>
          <label>Instructions<textarea required rows={10} maxLength={8000} value={instructions} onChange={event => setInstructions(event.target.value)} /></label>
        </>}
        <button type="submit" disabled={task ? repository === '' || (review || mode === 'form' ? !title.trim() : !prompt.trim()) : !title.trim() || !instructions.trim()}>{busy ? task && !review ? 'Preparing...' : 'Creating...' : task ? review ? 'Save task' : 'Prepare task draft' : 'Save agent'}</button>
        {task && review && <button type="button" className="secondary" onClick={() => { setTitle(originalInput.current.title); setNotes(originalInput.current.notes); setReview(false); }}>Revise input</button>}
      </fieldset>
      <button type="button" className="secondary" disabled={busy && (!task || review)} onClick={cancel}>Cancel creation</button>
      <p className="muted">Nothing is filed until you save. Cancellation discards the unsaved draft.</p>
    </form>
  </section>;
}
