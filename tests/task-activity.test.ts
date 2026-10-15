import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { taskActivity } from '../src/core/task-activity';
import { exampleWorkflow, Run } from '../src/contracts';
const run: Run = { version: 1, id: 'test', workflow: exampleWorkflow('activity'), workflowUri: 'file:///workflow', repositoryUri: 'file:///repo', taskUri: 'file:///task', status: 'running', createdAt: '2026-10-14', updatedAt: '2026-10-14', steps: { plan: { status: 'running' }, review: { status: 'queued' } } };
test('task indicators reflect observed workflow steps and explicit confirmation, not invented completion', () => {
  assert.equal(taskActivity('file:///other', [run], () => true).activity, 'No tracked run');
  assert.equal(taskActivity('file:///task', [run], () => true).activity, 'Running');
  assert.match(taskActivity('file:///task', [run], () => true).subtitle, /Draft a plan/);
  const waiting: Run = { ...run, status: 'waitingApproval', steps: { plan: { status: 'succeeded' }, review: { status: 'waitingApproval' } } };
  assert.equal(taskActivity('file:///task', [waiting], () => true).progress, 50);
  assert.equal(taskActivity('file:///task', [waiting], () => true).activity, 'Needs confirmation');
  assert.equal(taskActivity('file:///task', [waiting], () => false).activity, 'Resume needed');
  const finished: Run = { ...run, id: 'newer', status: 'succeeded', createdAt: '2026-10-15', steps: { plan: { status: 'succeeded' }, review: { status: 'succeeded' } } };
  assert.equal(taskActivity('file:///task', [finished], () => false).progress, 100);
  assert.equal(taskActivity('file:///task', [finished, run], id => id === run.id).activity, 'Running', 'Active linked run takes precedence over newer history');
  for (const status of ['failed', 'cancelled', 'interrupted'] as const) assert.notEqual(taskActivity('file:///task', [{ ...run, status }], () => false).activity, 'Running');
});
