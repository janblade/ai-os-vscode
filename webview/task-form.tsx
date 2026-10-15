import { useEffect, useState } from 'react';
import { DashboardMessage } from '../src/dashboard-contracts';
export interface TaskDraft {
  id: string; root: string; content: string; token: string; title: string;
  status: 'open' | 'inProgress' | 'done'; archived: boolean; bound: boolean; editableNotes: boolean; agentId?: string; agents?: { id: string; name: string }[];
}
export function TaskForm({ draft, revision, trusted, post, close, reload, onDirtyChange }: {
  draft: TaskDraft; revision: number; trusted: boolean; post: (message: DashboardMessage) => void; close: () => void; reload?: () => void; onDirtyChange?: (dirty: boolean) => void;
}) {
  const [title, setTitle] = useState(draft.title);
  const [status, setStatus] = useState(draft.status);
  const [agentId, setAgentId] = useState(draft.agentId ?? '');
  const [content, setContent] = useState(draft.content);
  const disabled = !trusted || draft.archived;
  const reference = { id: draft.id, revision, token: draft.token };
  const dirty = title !== draft.title || status !== draft.status || content !== draft.content || agentId !== (draft.agentId ?? '');
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  return <section className="task-form" aria-label="Edit task">
    <h2>{draft.archived ? 'Archived task' : 'Edit task'}</h2>
    <p className="muted">Notes and settings have separate save buttons. Unsaved changes stay here until saved or discarded.</p>
    {draft.bound ? <form onSubmit={event => { event.preventDefault(); post({ type: 'saveProperties', ...reference, title, status, agentId: agentId || null }); }}>
      <fieldset disabled={disabled}><label>Task title<input autoFocus={!disabled} required maxLength={200} value={title} onChange={event => setTitle(event.target.value)} /></label>
      <label>Task state<select value={status} onChange={event => setStatus(event.target.value as TaskDraft['status'])}><option value="open">Open</option><option value="inProgress">In progress</option><option value="done">Done</option></select></label>
      <label>Default agent<select value={agentId} onChange={event => setAgentId(event.target.value)}><option value="">No default agent</option>
        {agentId && !(draft.agents ?? []).some(agent => agent.id === agentId) && <option value={agentId}>Unavailable agent ({agentId})</option>}
        {(draft.agents ?? []).map(agent => <option key={agent.id} value={agent.id}>{agent.name} ({'provider' in agent ? String(agent.provider ?? 'workflow provider') : 'workflow provider'})</option>)}
      </select></label><p className="muted">Workflow agent steps inherit this preset unless the step selects another agent or opts out. It does not start an agent session.</p>
      <button disabled={title === draft.title && status === draft.status && agentId === (draft.agentId ?? '')}>Save properties</button></fieldset>
    </form> : <p className="notice">Adopt this task to edit properties or archive it. Notes can be edited independently.</p>}
    {draft.editableNotes ? <form onSubmit={event => { event.preventDefault(); post({ type: 'saveNotes', ...reference, content }); }}>
      <fieldset disabled={disabled}><label>Task notes<textarea rows={14} maxLength={256000} value={content} onChange={event => setContent(event.target.value)} /></label>
      <button disabled={content === draft.content}>Save notes</button></fieldset>
    </form> : <p className="notice">Identified memory entries require the memory amendment process; direct note editing is disabled.</p>}
    <div className="detail-actions">
      {draft.bound && <button className="secondary" disabled={!trusted || dirty} onClick={() => post({ type: 'archiveTask', ...reference, archived: !draft.archived })}>{draft.archived ? 'Restore task' : 'Archive task'}</button>}
      {reload && <button className="secondary" onClick={reload}>Reload saved task</button>}
      <button className="secondary" onClick={close}>{dirty ? 'Discard draft and close' : 'Close form'}</button>
    </div>
    {dirty && <p role="status" className="muted">Unsaved form draft. Save or discard it before archiving or restoring.</p>}
  </section>;
}
