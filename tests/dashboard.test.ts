import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { dashboardEntries, dashboardContent } from '../src/framework/dashboard';
import { handoffPrompt, parseDashboardMessage } from '../src/dashboard-contracts';

test('dashboard inventories legacy, invalid and bound tasks without changing memory', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-dashboard-'));
  const write = async (name: string, content: string) => { const file = path.join(root, name); await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, content); };
  try {
    const note = '.ai-os/memory/tasks/legacy.md';
    await write(note, '# Legacy\n<script>untrusted text</script>');
    await write('.ai-os/memory/tasks/bound.md', '# Bound');
    await write('.ai-os/memory/tasks/bound.task.json', JSON.stringify({ version: 1, id: '00000000-0000-0000-0000-000000000000', title: 'Bound', status: 'inProgress', note: '.ai-os/memory/tasks/bound.md', repository: '.' }));
    await write('.ai-os/memory/tasks/broken.md', '# Broken');
    await write('.ai-os/memory/tasks/broken.task.json', '{}');
    await write('.ai-os/memory/episodic/decisions.jsonl', '{"what":"Decision"}\n');
    await write('.ai-os/memory/semantic/knowledge/facts.md', '# Facts');
    await write('.ai-os/workflows/example.workflow.json', '{}');
    const entries = await dashboardEntries(root, [root]);
    assert.equal(entries.length, 6);
    const legacy = entries.find(entry => entry.id === note)!;
    assert.equal(legacy.status, 'unbound');
    assert.equal(entries.find(entry => entry.title === 'Bound')?.status, 'inProgress');
    assert.equal(entries.find(entry => entry.id.endsWith('broken.md'))?.status, 'invalid');
    assert.equal(entries.find(entry => entry.id.endsWith('decisions.jsonl'))?.category, 'Episodic');
    assert.equal(entries.find(entry => entry.id.endsWith('workflow.json'))?.kind, 'workflow');
    assert.match(await dashboardContent(root, legacy), /<script>/);
    await write('AGENTS.md', 'x'.repeat(256001));
    const instructions = (await dashboardEntries(root, [root])).find(entry => entry.id === 'AGENTS.md')!;
    assert.equal(instructions.category, 'Instructions');
    await assert.rejects(dashboardContent(root, instructions), /size limit/);
    const prompt = handoffPrompt(legacy, root, 'park');
    assert.match(prompt, /OS_COMMAND WRAP/); assert.match(prompt, /Keep the task open/); assert.match(prompt, /unbound; confirm repository/);
    assert.match(handoffPrompt(legacy, root, 'resume'), /do not infer them from the filename/);
    assert.equal(await dashboardContent(root, legacy), '# Legacy\n<script>untrusted text</script>');
    await assert.rejects(dashboardContent(root, { ...legacy, id: '../outside.md' }), /Unsafe workspace path/);
    assert.throws(() => handoffPrompt({ ...legacy, kind: 'memory' }, root, 'park'), /Choose a task/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('dashboard rejects forged actions, paths and invalid revisions at its message boundary', () => {
  assert.deepEqual(parseDashboardMessage({ type: 'navigate', page: 'run' }), { type: 'navigate', page: 'run' });
  assert.throws(() => parseDashboardMessage({ type: 'navigate', page: 'shell' }));
  assert.throws(() => parseDashboardMessage({ type: 'navigate', page: 'task', path: '/secret' }));
  assert.deepEqual(parseDashboardMessage({ type: 'action', action: 'refresh' }), { type: 'action', action: 'refresh' });
  assert.deepEqual(parseDashboardMessage({ type: 'select', id: 'task', revision: 1 }), { type: 'select', id: 'task', revision: 1 });
  for (const value of [null, [], { type: 'action', action: 'shell' }, { type: 'action', action: 'refresh', path: '/secret' },
    { type: 'open', id: 'x', revision: 0 }, { type: 'open', id: 'x', revision: 1.5 }, { type: 'action', action: { toString: () => 'refresh' } }]) assert.throws(() => parseDashboardMessage(value));
});


test('memory proposals expose review metadata while support files have no approval action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-proposals-'));
  try {
    const directory = path.join(root, '.ai-os/memory/proposals'); await mkdir(directory, { recursive: true });
    const proposal = { version: 1, target: '.ai-os/memory/plans/plan.md', expectedHash: null, content: '# Plan', reason: 'Save approved plan', evidence: [{ scope: 'framework', source: '.ai-os/memory/proposals/evidence.md', sha256: 'a'.repeat(64) }] };
    await writeFile(path.join(directory, 'plan.json'), JSON.stringify(proposal)); await writeFile(path.join(directory, 'evidence.md'), '# Evidence'); await writeFile(path.join(directory, 'transcript.json'), '{}');
    const entries = await dashboardEntries(root, [root]);
    assert.deepEqual(entries.find(entry => entry.title === 'plan.json')!.proposal, { target: proposal.target, reason: proposal.reason });
    for (const name of ['evidence.md', 'transcript.json']) { const entry = entries.find(entry => entry.title === name)!; assert.equal(entry.category, 'Proposal support files'); assert.equal(entry.proposal, undefined); }
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('recovery replies require a bound request ID and a finite offered-choice index', () => {
  const requestId='11111111-1111-1111-1111-111111111111';
  for(const choice of [0,1,null]) assert.deepEqual(parseDashboardMessage({type:'answerRecovery',requestId,choice}),{type:'answerRecovery',requestId,choice});
  for(const choice of [-1,1.5,'0',1000,NaN]) assert.throws(()=>parseDashboardMessage({type:'answerRecovery',requestId,choice}));
  assert.throws(()=>parseDashboardMessage({type:'answerRecovery',requestId:'other',choice:0}));
});
