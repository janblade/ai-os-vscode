import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createTask, readBinding, tasks } from '../src/framework/tasks';
import { createAgent, parseAgent } from '../src/framework/agents';
import { parseDashboardMessage } from '../src/dashboard-contracts';

test('creation forms validate native profile fields and reject forged paths/permissions and oversized drafts', () => {
  const requestId = '11111111-1111-1111-1111-111111111111';
  const task = { type: 'createTask', requestId, title: 'Bug', draftId: requestId, repository: 0, notes: 'Evidence', agentId: requestId };
  const agent = { type: 'createAgent', requestId, name: 'Investigator', provider: 'claude', model: '', instructions: 'Investigate' };
  const prepare = { type: 'prepareTask', requestId, description: 'Bug report', provider: 'codex', repository: 0 };
  assert.deepEqual(parseDashboardMessage(prepare), prepare);
  for (const invalid of [{ ...prepare, root: 'C:/other' }, { ...prepare, provider: 'mock' }, { ...prepare, repository: -1 }, { ...prepare, description: '' }, { ...task, draftId: '../forged' }]) assert.throws(() => parseDashboardMessage(invalid));
  assert.deepEqual(parseDashboardMessage(task), task); assert.deepEqual(parseDashboardMessage(agent), agent);
  for (const value of [{ ...task, root: 'C:/elsewhere' }, { ...task, repository: -1 }, { ...task, repository: '../outside' }, { ...task, notes: 'x'.repeat(200001) }, { ...task, agentId: '../secret' }, { ...agent, command: 'anything' }, { ...agent, provider: 'other' }, { ...agent, instructions: '' }, { ...agent, model: 'x\ny' }, { ...agent, name: 'x\ny' }]) assert.throws(() => parseDashboardMessage(value));
});
test('form saves persist initial notes/default agent and provider details using exclusive creation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-creation-'));
  try {
    await mkdir(path.join(root, '.ai-os/memory/tasks'), { recursive: true });
    const file = await createAgent(root, 'Investigator', 'claude', { model: 'custom-model', instructions: 'Follow ticket evidence.' });
    const agent = parseAgent(await readFile(path.join(root, file), 'utf8'));
    assert.equal(agent.provider, 'claude'); assert.equal(agent.model, 'custom-model'); assert.equal(agent.instructions, 'Follow ticket evidence.');
    const task = await createTask(root, 'Ticket bug', '.', undefined, { agentId: agent.id, notes: 'Evidence <script>inert data</script>' });
    assert.equal((await readBinding(root, task.note))?.agentId, agent.id);
    assert.match(await readFile(path.join(root, task.note), 'utf8'), /Evidence <script>inert data/);
    const count = (await tasks(root)).length;
    await assert.rejects(createTask(root, 'Invalid agent', '.', undefined, { agentId: '00000000-0000-0000-0000-000000000000' }));
    await assert.rejects(createTask(root, 'Oversized notes', '.', undefined, { notes: '\u4e00'.repeat(70000) }));
    assert.equal((await tasks(root)).length, count, 'Invalid submissions create no note');
    await assert.rejects(createAgent(root, 'Empty', 'codex', { instructions: '' }));
  } finally { await rm(root, { recursive: true, force: true }); }
});
