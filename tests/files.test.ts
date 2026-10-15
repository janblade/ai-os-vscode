import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, rm, symlink, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createFile, safePath } from '../src/core/files';
import { adoptTask, createTask, readBinding, taskEntries, sidecar } from '../src/framework/tasks';

export async function fixture(): Promise<{ root: string; close: () => Promise<void> }> {
  const root = path.resolve('.test-build', `fixture-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  return { root, close: () => rm(root, { recursive: true, force: true }) };
}

test('workspace paths reject escapes, reserved Windows names and junctions', async () => {
  const f = await fixture();
  try {
    for (const name of ['../secret', '/absolute', 'a\\b', 'a:file', 'a/../b', 'a//b', 'con.txt', 'file.']) await assert.rejects(safePath(f.root, name));
    await mkdir(path.join(f.root, 'target'));
    await symlink(path.join(f.root, 'target'), path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(safePath(f.root, 'linked/file'), /Linked/);
  } finally { await f.close(); }
});

test('creating and adopting notes never overwrites or renames existing content', async () => {
  const f = await fixture();
  try {
    const note = '.ai-os/memory/tasks/hiro-mobile__legacy.md';
    const original = '# Existing\r\n\r\n<!-- AIOS-ENTRY keep -->\r\n';
    await createFile(f.root, note, original);
    const binding = await adoptTask(f.root, note, 'Legacy task', '.');
    assert.equal(binding.note, note);
    assert.equal(await readFile(path.join(f.root, note), 'utf8'), original);
    await assert.rejects(adoptTask(f.root, note, 'Duplicate', '.'));
    const created = await createTask(f.root, 'New task', '.');
    assert.equal((await readBinding(f.root, created.note))?.id, created.id);
    await assert.rejects(createFile(f.root, note, 'replace'));
    assert.equal(await readFile(path.join(f.root, note), 'utf8'), original);
  } finally { await f.close(); }
});

test('a malformed task binding does not hide other notes or valid bindings', async () => {
  const f = await fixture();
  try {
    const good = await createTask(f.root, 'Valid', '.');
    const bad = '.ai-os/memory/tasks/bad.md';
    await createFile(f.root, bad, '# Still readable');
    await createFile(f.root, sidecar(bad), '{ invalid JSON');
    const entries = await taskEntries(f.root);
    assert.equal(entries.find(item => item.note === good.note)?.binding?.id, good.id);
    assert.match(entries.find(item => item.note === bad)?.error ?? '', /SyntaxError/);
  } finally { await f.close(); }
});
