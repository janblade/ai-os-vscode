import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createAgent, readAgent, agentEntries, parseAgent, resolveAgents } from '../src/framework/agents';
import { exampleWorkflow, applyChange, parseMessage } from '../src/contracts';
import { createTask, readBinding } from '../src/framework/tasks';
import { editTask, taskSnapshot } from '../src/framework/task-edit';

test('agent files validate ownership, isolate malformed entries and reject credentials/executable fields', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-agents-'));
  try {
    const file = await createAgent(root, 'Investigator');
    const profile = parseAgent(await (await import('node:fs/promises')).readFile(path.join(root, file), 'utf8'));
    assert.equal((await readAgent(root, profile.id)).name, 'Investigator');
    await writeFile(path.join(root, '.ai-os/agents/broken.agent.json'), '{}');
    assert.equal((await agentEntries(root)).filter(entry => entry.problem).length, 1);
    for (const change of [{ provider: 'unknown' }, { instructions: 'x'.repeat(8001) }, { apiKey: 'secret' }, { command: 'execute' }, { id: '../outside' }]) assert.throws(() => parseAgent(JSON.stringify({ ...profile, ...change })));
    await assert.rejects(readAgent(root, '../outside'), /Invalid agent ID/);
    await writeFile(path.join(root, file), JSON.stringify({ ...profile, id: '11111111-1111-1111-1111-111111111111' }));
    await assert.rejects(readAgent(root, profile.id), /filename/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('task defaults, workflow overrides and explicit opt-out resolve into immutable run snapshots', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-agent-snapshot-'));
  try {
    const first = await createAgent(root, 'Investigator'); const second = await createAgent(root, 'Reviewer', 'codex');
    const fs = await import('node:fs/promises');
    const a = parseAgent(await fs.readFile(path.join(root, first), 'utf8')); const b = parseAgent(await fs.readFile(path.join(root, second), 'utf8'));
    const task = await createTask(root, 'Bug', '.');
    await editTask(root, task.note, (await taskSnapshot(root, task.note)).token, { kind: 'properties', title: task.title, status: 'open', agentId: a.id });
    assert.equal((await readBinding(root, task.note))?.agentId, a.id);
    const workflow = exampleWorkflow('agents'); const original = JSON.stringify(workflow);
    const inherited = await resolveAgents(root, workflow, a.id);
    assert.equal((inherited.nodes[0].config.agentSnapshot as typeof a).name, 'Investigator');
    assert.match(String(inherited.nodes[0].config.prompt), /Step request:/); assert.equal(JSON.stringify(workflow), original);
    const configured = applyChange(workflow, { kind: 'configure', nodeId: 'plan', label: 'Plan', prompt: 'Inspect bug', agentId: b.id });
    assert.equal((await resolveAgents(root, configured, a.id)).nodes[0].config.agentId, b.id);
    assert.equal((await resolveAgents(root, configured, a.id)).nodes[0].config.provider, 'codex');
    const none = applyChange(configured, { kind: 'configure', nodeId: 'plan', label: 'Plan', prompt: 'Inspect bug', agentId: null });
    none.nodes[0].config.agentSnapshot = { name: 'Forged activity label' };
    const optedOut = await resolveAgents(root, none, a.id);
    assert.equal(optedOut.nodes[0].config.prompt, 'Inspect bug');
    assert.equal(optedOut.nodes[0].config.agentSnapshot, undefined);
    const defaults = applyChange(none, { kind: 'configure', nodeId: 'plan', label: 'Plan', prompt: 'Inspect bug', agentId: '' });
    assert.equal((await resolveAgents(root, defaults, a.id)).nodes[0].config.agentId, a.id);
    await fs.writeFile(path.join(root, first), JSON.stringify({ ...a, instructions: 'New instructions' }));
    assert.notEqual((inherited.nodes[0].config.agentSnapshot as typeof a).instructions, 'New instructions');
    await assert.rejects(resolveAgents(root, workflow, '00000000-0000-0000-0000-000000000000'), /ENOENT/);
    await editTask(root, task.note, (await taskSnapshot(root, task.note)).token, { kind: 'properties', title: task.title, status: 'open', agentId: null });
    assert.equal((await readBinding(root, task.note))?.agentId, undefined);
    assert.throws(() => parseMessage({ type: 'update', revision: 1, change: { kind: 'configure', nodeId: 'plan', label: 'Plan', prompt: 'Bug', agentId: '../secret' } }));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('registered framework profiles and templates share one model without granting permissions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-unified-'));
  try {
    await mkdir(path.join(root, '.ai-os/agents/templates'), { recursive: true });
    const supervisor = { agent_id: 'supervisor', name: 'OS Supervisor', role: 'Coordinator', system_prompt_extension: 'Coordinate the task.', allowed_skills: ['*'], execution_boundary: ['*'], approval_gate: 'high-risk-only', default_model_tier: 'reasoning' };
    await writeFile(path.join(root, '.ai-os/agents/supervisor.json'), JSON.stringify(supervisor));
    const index = { version: '1.0.0', description: 'Keep registry metadata', active_profiles: [{ agent_id: 'supervisor', file: 'agents/supervisor.json', primary: true }] };
    await writeFile(path.join(root, '.ai-os/agents/index.json'), JSON.stringify(index));
    await writeFile(path.join(root, '.ai-os/agents/templates/api.json'), JSON.stringify({ ...supervisor, agent_id: 'api_developer', name: 'Backend Specialist', execution_boundary: ['**/backend/**'] }));
    const entries = await agentEntries(root); assert.equal(entries.length, 2);
    assert.equal(entries.find(entry => entry.template)?.agent?.id, 'api_developer');
    const workflow = exampleWorkflow('unified'); workflow.nodes[0].config.provider = 'codex'; workflow.nodes[0].config.model = 'native-model';
    const resolved = await resolveAgents(root, workflow, 'supervisor');
    assert.equal(resolved.nodes[0].config.provider, 'codex'); assert.equal(resolved.nodes[0].config.model, 'native-model');
    assert.match(String(resolved.nodes[0].config.prompt), /cannot grant permissions/);
    assert.deepEqual((resolved.nodes[0].config.agentSnapshot as any).execution_boundary, ['*']);
    const task = await createTask(root, 'Bug', '.', undefined, { agentId: 'supervisor' });
    assert.equal((await readBinding(root, task.note))?.agentId, 'supervisor');
    await assert.rejects(readAgent(root, 'api_developer'), /ENOENT/, 'Templates cannot be assigned before registration');
    const file = await createAgent(root, 'API worker', null, { template: '.ai-os/agents/templates/api.json' });
    const raw = JSON.parse(await readFile(path.join(root, file), 'utf8'));
    assert.ok(raw.agent_id); assert.equal(raw.id, undefined); assert.equal(raw.provider, undefined);
    assert.deepEqual(raw.execution_boundary, ['**/backend/**']);
    const after = JSON.parse(await readFile(path.join(root, '.ai-os/agents/index.json'), 'utf8'));
    assert.equal(after.description, index.description); assert.equal(after.active_profiles[0].primary, true);
    assert.equal((await readAgent(root, raw.agent_id)).name, 'API worker');
    assert.throws(() => parseAgent(JSON.stringify({ ...supervisor, permissions: { write: ['*'] } })));
    assert.throws(() => parseAgent(JSON.stringify({ ...supervisor, command: 'shell' })));
    await writeFile(path.join(root, '.ai-os/agents/index.json'), JSON.stringify({ ...index, active_profiles: [{ agent_id: 'supervisor', file: '../BOOT.md' }] }));
    await assert.rejects(createAgent(root, 'Do not save'), /registration/);
    await assert.rejects(readAgent(root, 'supervisor'), /registration/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('legacy UUID references survive registration without profile rewrites and ambiguous IDs fail closed', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-legacy-registration-'));
  try {
    await mkdir(path.join(root, '.ai-os/agents'), { recursive: true });
    const id = '11111111-1111-1111-1111-111111111111';
    const file = `.ai-os/agents/agent-${id}.agent.json`;
    const legacy = JSON.stringify({ version: 1, id, name: 'Legacy worker', provider: 'claude', instructions: 'Inspect.' });
    await writeFile(path.join(root, file), legacy);
    await createAgent(root, 'New worker', 'codex');
    const index = JSON.parse(await readFile(path.join(root, '.ai-os/agents/index.json'), 'utf8'));
    assert.ok(index.active_profiles.some((entry: any) => entry.agent_id === id && entry.file === file.slice('.ai-os/'.length)));
    assert.equal(await readFile(path.join(root, file), 'utf8'), legacy);
    assert.equal((await readAgent(root, id)).provider, 'claude');
    const workflow = exampleWorkflow('legacy'); assert.equal((await resolveAgents(root, workflow, id)).nodes[0].config.agentId, id);
    await writeFile(path.join(root, '.ai-os/agents/duplicate.json'), JSON.stringify({ agent_id: id, name: 'Conflicting worker', system_prompt_extension: 'Other.' }));
    index.active_profiles.find((entry: any) => entry.agent_id === id).file = 'agents/duplicate.json';
    await writeFile(path.join(root, '.ai-os/agents/index.json'), JSON.stringify(index));
    await assert.rejects(readAgent(root, id), /Ambiguous/);
    assert.ok((await agentEntries(root)).filter(entry => entry.agent?.id === id).every(entry => entry.problem));
  } finally { await rm(root, { recursive: true, force: true }); }
});
