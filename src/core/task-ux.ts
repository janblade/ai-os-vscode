import type { Run } from '../contracts';
import type { DashboardEntry } from '../dashboard-contracts';
export function needsAttention(entry: DashboardEntry): boolean {
  return !entry.archived && entry.status !== 'done' && Boolean(entry.problem || ['unbound', 'invalid'].includes(entry.status ?? '') || ['waitingApproval', 'interrupted', 'failed'].includes(entry.runStatus ?? '') || entry.runStatus === 'succeeded' && !entry.reviewRecorded);
}
export function taskList(entries: DashboardEntry[], filter: string): DashboardEntry[] {
  const visible = entries.filter(entry => filter === 'all' || filter === 'recent' || (filter === 'attention' ? needsAttention(entry) : filter === 'running' ? entry.runActive : entry.status === filter));
  return visible.sort(byRecency);
}
export function byRecency(a: { updatedAt?: string; title: string }, b: { updatedAt?: string; title: string }): number {
  const time = (value?: string) => { const parsed = Date.parse(value ?? ''); return Number.isFinite(parsed) ? parsed : 0; };
  return time(b.updatedAt) - time(a.updatedAt) || a.title.localeCompare(b.title);
}
export function repositoryLabel(repository?: string): string { return repository?.split(/[\\/]/).filter(Boolean).at(-1) ?? 'Repository not linked'; }
/** Read stored task notes as text; never render their contents as HTML. */
export function taskSummary(content: string): { summary?: string; nextStep?: string } {
  const section = (text: string, heading: string) => text.match(new RegExp(`^#{2,3} ${heading}\\s*\\r?\\n([\\s\\S]*?)(?=^#{1,3} |$(?![\\s\\S]))`, 'mi'))?.[1].trim().slice(0, 1000);
  const lastHandoff = content.lastIndexOf('## Dashboard handoff - ');
  return { summary: section(content, 'Summary'), nextStep: lastHandoff >= 0 ? section(content.slice(lastHandoff), 'Next step') : section(content, 'Next steps') };
}

export function runDescription(run: Run, taskTitle?: string): { title: string; subtitle: string } {
  const phase = run.workflow.nodes.find(node => ['running', 'waitingApproval', 'failed', 'interrupted'].includes(run.steps[node.id].status));
  const attempt = run.recovery ? run.recovery.mode === 'retry' ? 'Retry' : 'Fresh restart' : 'Initial run';
  return { title: `${taskTitle ?? run.story?.title ?? run.workflow.name} - ${new Date(run.createdAt).toLocaleString()}`, subtitle: [taskTitle || run.story ? run.workflow.name : undefined, attempt, phase ? `${phase.label}: ${run.steps[phase.id].activity ?? run.steps[phase.id].status}` : run.status, `Run ${run.id.slice(0, 8)}`].filter(Boolean).join(' - ') };
}
