import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createFile } from '../src/core/files';
import { discoverFrameworks, inspectFramework, repositoryTargets, resolveRepository, detectedConfiguration } from '../src/framework/workspace';
import { FrameworkPayload, initializeFramework } from '../src/framework/install';
import { createTask, readBinding } from '../src/framework/tasks';

const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const payload: FrameworkPayload = { format: 1, commit: 'a'.repeat(40), version: '2.9.0', files: [
  { path: 'manifest.json', content: '{"ai_os_version":"2.9.0"}', sha256: hash('{"ai_os_version":"2.9.0"}') },
  { path: 'BOOT.md', content: '# Framework', sha256: hash('# Framework') },
] };
async function fixture() {
  const root = path.resolve('.test-build', `onboarding-${randomUUID()}`); await mkdir(root, { recursive: true });
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}
test('fresh initialization is exclusive, preserves Claude config and rejects corrupt bundles before writing', async () => {
  const f = await fixture();
  try {
    await createFile(f.root, '.claude/settings.json', '{"hooks":{"keep":true}}');
    await assert.rejects(initializeFramework(f.root, { ...payload, files: [{ ...payload.files[0], sha256: 'bad' }] }));
    assert.equal(await inspectFramework(f.root), undefined);
    await initializeFramework(f.root, payload);
    assert.equal((await inspectFramework(f.root))?.status, 'ready');
    await createFile(f.root, '.ai-os/memory/tasks/existing.md', 'Keep this task');
    await assert.rejects(initializeFramework(f.root, payload), /existing .ai-os/);
    assert.equal(await readFile(path.join(f.root, '.ai-os/memory/tasks/existing.md'), 'utf8'), 'Keep this task');
    assert.equal(await readFile(path.join(f.root, '.claude/settings.json'), 'utf8'), '{"hooks":{"keep":true}}');
    assert.deepEqual(await detectedConfiguration(f.root), ['.ai-os', '.claude/settings.json']);
  } finally { await f.close(); }
});
test('only our interrupted installation resumes, without replacing modified files', async () => {
  const f = await fixture();
  try {
    const receipt = JSON.stringify({ format: 1, commit: payload.commit, bundle: hash(JSON.stringify(payload)) }) + '\n';
    await createFile(f.root, '.ai-os/.installing.json', receipt);
    await createFile(f.root, '.ai-os/BOOT.md', 'User content');
    assert.equal((await inspectFramework(f.root))?.status, 'incomplete');
    await assert.rejects(initializeFramework(f.root, payload), /conflict/);
    assert.equal(await readFile(path.join(f.root, '.ai-os/BOOT.md'), 'utf8'), 'User content');
    await assert.rejects(initializeFramework(f.root, { ...payload, version: 'different' }), /different bundle/);
  } finally { await f.close(); }
  const clean = await fixture();
  try {
    await createFile(clean.root, '.ai-os/.installing.json', JSON.stringify({ format: 1, commit: payload.commit, bundle: hash(JSON.stringify(payload)) }) + '\n');
    await createFile(clean.root, '.ai-os/BOOT.md', payload.files[1].content);
    await initializeFramework(clean.root, payload);
    assert.equal((await inspectFramework(clean.root))?.status, 'ready');
  } finally { await clean.close(); }
});
test('discovery covers container and saved multi-root workspaces without searching ancestors', async () => {
  const f = await fixture();
  try {
    await mkdir(path.join(f.root, 'api')); await mkdir(path.join(f.root, 'mobile'));
    await initializeFramework(f.root, payload);
    assert.equal((await discoverFrameworks([f.root])).length, 1);
    assert.deepEqual(await discoverFrameworks([path.join(f.root, 'api')]), []);
    assert.equal((await discoverFrameworks([path.join(f.root, 'api')], path.join(f.root, 'hiro.code-workspace'))).length, 1);
    await initializeFramework(path.join(f.root, 'mobile'), payload);
    assert.equal((await discoverFrameworks([path.join(f.root, 'mobile')], path.join(f.root, 'hiro.code-workspace'))).length, 2);
    assert.equal((await discoverFrameworks([f.root], path.join(f.root, 'hiro.code-workspace'))).length, 1);
  } finally { await f.close(); }
});
test('repository bindings support unrelated folders and become unavailable when a folder is removed', async () => {
  const storage = await fixture(); const project = await fixture();
  try {
    await mkdir(path.join(project.root, 'nested', '.git'), { recursive: true });
    const folders = [project.root];
    const target = { folder: pathToFileURL(project.root).href, path: 'nested' };
    assert.equal((await repositoryTargets(folders)).length, 2);
    assert.equal(await resolveRepository(storage.root, target, folders), path.join(project.root, 'nested'));
    assert.equal(await resolveRepository(storage.root, target, [...folders, path.join(project.root, 'missing-folder')]), path.join(project.root, 'nested'));
    const task = await createTask(storage.root, 'External repository', target, folders);
    await symlink(project.root, path.join(storage.root, 'nested'), process.platform === 'win32' ? 'junction' : 'dir');
    assert.equal((await readBinding(storage.root, task.note))?.version, 2);
    await assert.rejects(resolveRepository(storage.root, target, []), /no longer included/);
    assert.ok(await readBinding(storage.root, task.note));
    await assert.rejects(resolveRepository(storage.root, { ...target, path: '../escape' }, folders), /Unsafe/);
    await assert.rejects(resolveRepository(storage.root, '.', folders), /no longer included/);
    assert.equal(await resolveRepository(project.root, 'nested', folders), path.join(project.root, 'nested'));
  } finally { await storage.close(); await project.close(); }
});
