import { Run } from '../contracts';
export interface TaskActivity { runStatus?: Run['status']; runActive?: boolean; reviewRecorded?: boolean; updatedAt?: string; activity: string; subtitle: string; progress?: number; progressLabel: string; runId?: string }
export function taskActivity(taskUri: string, runs: Run[], active: (id: string) => boolean, taskId?: string): TaskActivity {
  const linked = runs.filter(run => (taskId && run.taskId === taskId) || run.taskUri === taskUri || (!run.taskId && taskUri.includes('/archived_tasks/') && run.taskUri === taskUri.replace('/archived_tasks/', '/tasks/'))).sort((a, b) => Number(active(b.id)) - Number(active(a.id)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  const run = linked[0];
  if (!run) return { activity: 'No tracked run', subtitle: 'No extension run observed. Host agent sessions are not tracked.', progressLabel: 'No measured workflow progress' };
  const completed = Object.values(run.steps).filter(step => step.status === 'succeeded').length;
  const progress = Math.round(completed / run.workflow.nodes.length * 100);
  const live = active(run.id);
  const step = run.workflow.nodes.find(node => run.steps[node.id].status === 'waitingApproval' || run.steps[node.id].status === 'running')
    ?? run.workflow.nodes.find(node => run.steps[node.id].status === 'failed');
  const memoryWait = Object.values(run.steps).some(step => step.memoryApproval);
  let activity = memoryWait ? live ? 'Waiting for memory approval' : 'Interrupted during memory approval' : run.status === 'succeeded' ? 'Run finished' : run.status === 'waitingApproval' ? (live ? 'Needs confirmation' : 'Resume needed')
    : run.status === 'running' || run.status === 'queued' ? (live ? (run.status === 'running' ? 'Running' : 'Queued') : 'Not running')
    : run.status === 'interrupted' ? 'Interrupted' : run.status === 'failed' ? 'Failed' : 'Cancelled';
  if (Object.values(run.steps).some(step=>step.skipReason) && !live) activity = 'Ended with skipped phases';
  if (!live && run.status === 'waitingApproval') activity = 'Resume needed';
  const profile = step?.config.agentSnapshot as { name?: string } | undefined;
  return { runStatus: run.status, runActive: live, reviewRecorded: Boolean(run.review), updatedAt: run.updatedAt, activity, progress, runId: run.id, progressLabel: `${completed} of ${run.workflow.nodes.length} workflow steps completed`,
    subtitle: `${step?.kind === 'agent' ? String(step.config.provider) : [...new Set(run.workflow.nodes.filter(node => node.kind === 'agent').map(node => node.config.provider))].join('/')} run - ${run.workflow.name}${run.story ? ' - Story: ' + run.story.title : ''}${step ? ` - ${profile?.name ? profile.name + ': ' : ''}${run.steps[step.id].activity ?? step.label}` : ''}${!live && run.status === 'waitingApproval' ? ' - Saved approval; inspect before continuing' : ''}` };
}
