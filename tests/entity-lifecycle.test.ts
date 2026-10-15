import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm, rename, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTask, readBinding, sidecar, archiveDirectory } from '../src/framework/tasks';
import { dashboardEntries } from '../src/framework/dashboard';
import { taskActivity } from '../src/core/task-activity';
import { hash, parseProposal, verifyProposal, applyProposal, proposalInventory } from '../src/framework/memory-proposal';
import { projectPolicy } from '../src/framework/policy';
const exec = promisify(execFile);
const python = process.platform === 'win32' ? 'python' : 'python3';
const identity = path.resolve('runtime/task_identity.py');
const archive = path.resolve('runtime/archive_task.py');
test('work-item identity bridges the Python resolver and survives pair archive/restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-identity-'));
  try {
    const task = await createTask(root, 'Bug', '.');
    assert.match(await readFile(path.join(root, task.note), 'utf8'), new RegExp(`Task-ID: ${task.id}`));
    const args = ['-I', '-B', identity, '--root', root, '--repository', root, '--task-id', task.id];
    assert.equal((await exec(python, args)).stdout.trim(), task.note);
    await exec(python, ['-I', '-B', archive, '--root', root, '--note', task.note]);
    const moved = `${archiveDirectory}/${path.basename(task.note)}`;
    assert.equal((await readBinding(root, moved))?.id, task.id);
    assert.equal((await dashboardEntries(root, [root])).find(entry => entry.taskId === task.id)?.archived, true);
    await assert.rejects(exec(python, args), /missing|ambiguous/);
    await exec(python, ['-I', '-B', archive, '--root', root, '--note', moved, '--restore']);
    assert.equal((await readBinding(root, task.note))?.id, task.id);
    assert.equal((await readBinding(root, task.note))?.archived, false);
    const repo2 = path.join(root, 'repo2'); await mkdir(repo2);
    const base = ['-I', '-B', identity, '--root', root, '--name', 'main', '--repository'];
    assert.notEqual((await exec(python, [...base, root])).stdout, (await exec(python, [...base, repo2])).stdout);
    await assert.rejects(exec(python, [...args.slice(0, -4), '--repository', repo2, '--task-id', task.id]), /another repository/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('legacy Markdown-only archive retains sidecar identity and run association', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-legacy-archive-'));
  try {
    const task = await createTask(root, 'Legacy bug', '.');
    await mkdir(path.join(root, archiveDirectory), { recursive: true });
    const moved = `${archiveDirectory}/${path.basename(task.note)}`;
    await rename(path.join(root, task.note), path.join(root, moved));
    assert.equal((await readBinding(root, moved))?.id, task.id);
    assert.equal((await dashboardEntries(root, [root])).filter(entry => entry.kind === 'task').length, 1);
    const run: any = { id: 'run', taskUri: 'file:///root/' + task.note, createdAt: '2026', workflow: { name: 'Flow', nodes: [{ id: 'step', kind: 'agent', config: { provider: 'mock' } }] }, status: 'succeeded', steps: { step: { status: 'succeeded' } } };
    assert.equal(taskActivity('file:///root/' + moved, [run], () => false, task.id).runId, 'run');
    await exec(python, ['-I', '-B', archive, '--root', root, '--note', moved, '--restore']);
    assert.equal((await readBinding(root, task.note))?.id, task.id);
    assert.equal(JSON.parse(await readFile(path.join(root, sidecar(task.note)), 'utf8')).archived, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reviewed memory rejects stale evidence and identity removal, then records accepted mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-memory-review-'));
  try {
    await mkdir(path.join(root, '.ai-os/memory/semantic'), { recursive: true });
    await writeFile(path.join(root, 'evidence.ts'), 'current code');
    const target = '.ai-os/memory/semantic/facts.md';
    const original = '<!-- AIOS-ENTRY fact-1 -->\nVerified old fact\n';
    await writeFile(path.join(root, target), original);
    const proposal = parseProposal(JSON.stringify({ version: 1, target, expectedHash: hash(original), content: '<!-- AIOS-ENTRY fact-1 -->\nVerified new fact\n', reason: 'Accepted bugfix', evidence: [{ scope: 'repository', source: 'evidence.ts', sha256: hash('current code') }] }));
    await assert.rejects(verifyProposal(root, root, { ...proposal, content: 'Removed entry' }), /markers/);
    await writeFile(path.join(root, 'evidence.ts'), 'changed code');
    await assert.rejects(applyProposal(root, root, proposal, async () => {}), /evidence changed/);
    assert.equal(await readFile(path.join(root, target), 'utf8'), original);
    await writeFile(path.join(root, 'evidence.ts'), 'current code');
    await applyProposal(root, root, proposal, async () => {});
    assert.equal(await readFile(path.join(root, target), 'utf8'), proposal.content);
    assert.match(await readFile(path.join(root, '.ai-os/memory/episodic/decisions.jsonl'), 'utf8'), /Human-reviewed memory amendment/);
    await applyProposal(root, root, proposal, async () => {}); // Already applied is a no-op, not a second acceptance.
    assert.throws(() => parseProposal(JSON.stringify({ ...proposal, target: '.ai-os/BOOT.md' })), /Invalid/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('policy resolution loads explicit archetype and detects enterprise signals in the selected repository', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-policy-'));
  try {
    for (const dir of ['genome/archetypes', 'rules']) await mkdir(path.join(root, '.ai-os', dir), { recursive: true });
    const files: Record<string, string> = { 'manifest.json': '{"project_archetype":"auto"}', 'genome/project_genome.json': '{}', 'genome/archetypes/index.json': '{"auto_detection_signals":{"enterprise_signals":["CONTRIBUTING.md"]}}', 'genome/archetypes/hobby.json': '{"rule_overrides":{}}', 'genome/archetypes/enterprise.json': '{"rule_overrides":{"R15":"approval"}}', 'rules/security_policy.md': 'Security', 'rules/evolution_policy.md': 'Evolution' };
    for (const [file, content] of Object.entries(files)) await writeFile(path.join(root, '.ai-os', file), content);
    assert.equal((await projectPolicy(root, root)).archetype, 'hobby');
    await writeFile(path.join(root, 'CONTRIBUTING.md'), 'Team policy');
    const policy = await projectPolicy(root, root); assert.equal(policy.archetype, 'enterprise');
    assert.ok(policy.sources.some(source => source.source.endsWith('enterprise.json')));
    await writeFile(path.join(root, '.ai-os/manifest.json'), '{"project_archetype":"invalid"}');
    await assert.rejects(projectPolicy(root, root), /Unsupported/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('archive recovery preserves CRLF, rejects collisions and completes interrupted note/sidecar moves', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-archive-recovery-'));
  try {
    const task = await createTask(root, 'Recovery', '.');
    const noteText = `# Recovery\r\nTask-ID: ${task.id}\r\n`;
    await writeFile(path.join(root, task.note), noteText);
    const target = `${archiveDirectory}/${path.basename(task.note)}`;
    await mkdir(path.join(root, archiveDirectory), { recursive: true });
    await writeFile(path.join(root, target), 'Other task');
    await assert.rejects(exec(python, ['-I', '-B', archive, '--root', root, '--note', task.note]), /destination exists/);
    assert.equal(await readFile(path.join(root, task.note), 'utf8'), noteText);
    await rm(path.join(root, target));
    const metadata = await readFile(path.join(root, sidecar(task.note)), 'utf8');
    const transaction = { note: target, files: [{ source: task.note, target, old: noteText, new: noteText }, { source: sidecar(task.note), target: sidecar(target), old: metadata, new: JSON.stringify({ ...JSON.parse(metadata), note: target, archived: true }) + '\n' }] };
    await mkdir(path.join(root, '.ai-os/memory/runtime'), { recursive: true });
    await writeFile(path.join(root, '.ai-os/memory/runtime/task-archive.json'), JSON.stringify(transaction));
    await writeFile(path.join(root, target), noteText);
    await exec(python, ['-I', '-B', archive, '--root', root, '--recover']);
    assert.equal(await readFile(path.join(root, target), 'utf8'), noteText);
    assert.equal((await readBinding(root, target))?.id, task.id);
    await assert.rejects(readFile(path.join(root, task.note)), /ENOENT/);
  } finally { await rm(root, { recursive: true, force: true }); }
});


test('proposal inventory deduplicates pending files, resolves applied/stale drafts and rejects duplicate plan targets', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-proposal-recovery-'));
  try {
    await mkdir(path.join(root, '.ai-os/memory/proposals'), { recursive: true });
    await mkdir(path.join(root, '.ai-os/memory/plans'), { recursive: true });
    await writeFile(path.join(root, 'evidence.txt'), 'verified');
    const proposal = parseProposal(JSON.stringify({ version: 1, target: '.ai-os/memory/plans/canonical.md', expectedHash: null, content: '# Plan\nImplement addition.\n', reason: 'Reviewed plan', evidence: [{ scope: 'repository', source: 'evidence.txt', sha256: hash('verified') }] }));
    for (const name of ['a.json', 'b.json']) await writeFile(path.join(root, '.ai-os/memory/proposals', name), JSON.stringify(proposal));
    const pending = await proposalInventory(root); assert.deepEqual(pending.map(entry => entry.state), ['pending', 'duplicate']); assert.equal(pending[1].canonical, pending[0].file);
    const visible = await dashboardEntries(root, []); assert.equal(visible.filter(entry => entry.proposal).length, 1);
    await applyProposal(root, root, proposal, async () => {});
    const receipts = (await readdir(path.join(root, '.ai-os/memory/proposals'))).filter(name => name.startsWith('accepted-'));
    await applyProposal(root, root, proposal, async () => {});
    assert.deepEqual((await readdir(path.join(root, '.ai-os/memory/proposals'))).filter(name => name.startsWith('accepted-')), receipts);
    assert.deepEqual((await proposalInventory(root)).map(entry => entry.state), ['applied', 'applied']);
    assert.equal((await dashboardEntries(root, [])).filter(entry => entry.proposal).length, 0);
    await assert.rejects(applyProposal(root, root, { ...proposal, target: '.ai-os/memory/plans/retry-copy.md' }, async () => {}), /Equivalent plan already exists/);
    await writeFile(path.join(root, proposal.target), 'Newer accepted plan');
    assert.deepEqual((await proposalInventory(root)).map(entry => entry.state), ['superseded', 'superseded']);
    await assert.rejects(applyProposal(root, root, proposal, async () => {}), /Memory changed/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
