import { exampleWorkflow, Run } from '../src/contracts';
import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { taskList, byRecency, runDescription, needsAttention, taskSummary, repositoryLabel } from '../src/core/task-ux';
import { parseDashboardMessage, DashboardEntry } from '../src/dashboard-contracts';
import { taskActivity } from '../src/core/task-activity';
const entry: DashboardEntry = { id: 'task', title: 'Task', kind: 'task', category: 'Working tasks', status: 'open' };
test('task views prioritize actionable activity and keep completed/archived items out of attention', () => {
  const running = { ...entry, id: 'running', runActive: true, runStatus: 'running' as const, updatedAt: '2026-10-14' };
  const waiting = { ...entry, id: 'waiting', runStatus: 'waitingApproval' as const, updatedAt: '2026-10-13' };
  const complete = { ...entry, id: 'done', status: 'done' as const, runStatus: 'succeeded' as const };
  const items = [running, complete, waiting];
  assert.equal(taskList(items, 'all')[0].id, 'running'); assert.equal(items[0].id, 'running');
  assert.deepEqual(taskList(items, 'running').map(item => item.id), ['running']);
  assert.deepEqual(taskList(items, 'attention').map(item => item.id), ['waiting']);
  assert.equal(taskList(items, 'recent')[0].id, 'running');
  assert.equal(needsAttention({ ...waiting, archived: true }), false);
  assert.equal(needsAttention({ ...entry, runStatus: 'succeeded', reviewRecorded: true }), false);
  assert.equal(needsAttention({ ...entry, status: 'unbound' }), true);
  assert.equal(taskActivity('file:///task', [], () => false).progress, undefined);
  assert.equal(parseDashboardMessage({ type: 'completeTask', id: 'task', revision: 1 }).type, 'completeTask');
  assert.throws(() => parseDashboardMessage({ type: 'completeTask', id: 'task', revision: 1, accepted: true }));
});
test('task overview derives stored summary and latest handoff without rendering or changing source', () => {
  const notes = '# Task\n### Summary\nFix login\n\n### Next steps\nInspect API\n\n## Dashboard handoff - first\n### Next step\nOld step\n### Verification\nNot run\n## Dashboard handoff - latest\n### Next step\nInspect service logs\n### Verification\nLog review only';
  assert.deepEqual(taskSummary(notes), { summary: 'Fix login', nextStep: 'Inspect service logs' });
  assert.deepEqual(taskSummary(notes.replace(/\n/g, '\r\n')), taskSummary(notes));
  assert.equal(taskSummary('### Summary\n<script>unsafe</script>').summary, '<script>unsafe</script>');
  assert.equal(repositoryLabel('C:\\work\\mobile'), 'mobile'); assert.equal(repositoryLabel('/work/mobile'), 'mobile');
});


test('all lists compare timestamps by instant and put undated entries last', () => {
  const entries = [{ title: 'Undated' }, { title: 'Earlier', updatedAt: '2026-10-15T13:00:00+08:00' }, { title: 'Latest', updatedAt: '2026-10-15T06:00:00Z' }];
  assert.deepEqual([...entries].sort(byRecency).map(entry => entry.title), ['Latest', 'Earlier', 'Undated']);
});

test('run labels identify task, workflow, attempt, failed phase and a short run identity', () => {
  const workflow = exampleWorkflow('fixture');
  const run = { id: '12345678-abcd', workflow, createdAt: '2026-10-15T06:00:00Z', status: 'failed', recovery: { mode: 'retry' }, steps: { plan: { status: 'failed', activity: 'Waiting for plan approval' }, approve: { status: 'queued' } } } as unknown as Run;
  const label = runDescription(run, 'Fix login');
  assert.match(label.title, /Fix login/); assert.match(label.subtitle, /Retry/); assert.match(label.subtitle, /Waiting for plan approval/); assert.match(label.subtitle, /Run 12345678/);
});


test('dashboard operation correlation preserves strict action validation', () => {
  const operationId = '12345678-1234-1234-1234-123456789012';
  assert.equal(parseDashboardMessage({ type: 'recoverRun', id: 'run:fixture', revision: 1, operationId }).operationId, operationId);
  for (const raw of [{ type: 'navigate', page: 'run', operationId }, { type: 'recoverRun', id: 'run:fixture', revision: 1, operationId: 'bad' }, { type: 'recoverRun', id: 'run:fixture', revision: 1, operationId, approveEverything: true }]) assert.throws(() => parseDashboardMessage(raw));
});
