import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTask, readBinding, sidecar, taskDirectory } from '../src/framework/tasks';
import { taskSnapshot, editTask } from '../src/framework/task-edit';
import { parseDashboardMessage } from '../src/dashboard-contracts';
import { dashboardEntries } from '../src/framework/dashboard';

test('task CRUD preserves unknown properties, notes, identity and stable paths across archive/restore', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-crud-'));
  try {
    const task = await createTask(root, 'Original', '.');
    await writeFile(path.join(root, task.note), '# Original\nBranch: feature/bug\nTask-ID: exact\n\n');
    const properties = path.join(root, sidecar(task.note));
    await writeFile(properties, JSON.stringify({ ...task, custom: { keep: true } }));
    let snapshot = await taskSnapshot(root, task.note);
    await editTask(root, task.note, snapshot.token, { kind: 'properties', title: 'CU-1234', status: 'inProgress' });
    assert.equal((await readBinding(root, task.note))?.title, 'CU-1234');
    assert.deepEqual(JSON.parse(await readFile(properties, 'utf8')).custom, { keep: true });
    assert.equal((await taskSnapshot(root, task.note)).content, snapshot.content);
    snapshot = await taskSnapshot(root, task.note);
    await editTask(root, task.note, snapshot.token, { kind: 'notes', content: '# Original\nBranch: feature/bug\nTask-ID: exact\n\nConfirmed cause\n' });
    snapshot = await taskSnapshot(root, task.note);
    await assert.rejects(editTask(root, task.note, snapshot.token, { kind: 'notes', content: '# Changed\nBranch: other\n' }), /Preserve the task identity/);
    await editTask(root, task.note, snapshot.token, { kind: 'archive', archived: true });
    assert.equal((await dashboardEntries(root, [root])).find(entry => entry.id === task.note)?.archived, true);
    assert.equal((await taskSnapshot(root, task.note)).content, snapshot.content);
    snapshot = await taskSnapshot(root, task.note);
    await editTask(root, task.note, snapshot.token, { kind: 'archive', archived: false });
    assert.equal((await readBinding(root, task.note))?.archived, false);
    assert.equal((await readBinding(root, task.note))?.note, task.note);
    assert.equal((await readdir(path.join(root, taskDirectory))).length, 2);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('stale drafts and changes during preparation are rejected without replacing external content', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-conflict-'));
  try {
    const task = await createTask(root, 'Original', '.');
    let snapshot = await taskSnapshot(root, task.note);
    await writeFile(path.join(root, task.note), 'Agent edit');
    await assert.rejects(editTask(root, task.note, snapshot.token, { kind: 'notes', content: 'Stale draft' }), /changed on disk/);
    assert.equal((await taskSnapshot(root, task.note)).content, 'Agent edit');
    snapshot = await taskSnapshot(root, task.note);
    let validations = 0;
    await assert.rejects(editTask(root, task.note, snapshot.token, { kind: 'properties', title: 'Changed', status: 'done' }, async () => {
      if (++validations === 2) await writeFile(path.join(root, sidecar(task.note)), JSON.stringify({ ...task, title: 'External edit' }));
    }), /changed on disk/);
    assert.equal((await readBinding(root, task.note))?.title, 'External edit');
    assert.equal((await readdir(path.join(root, taskDirectory))).length, 2, 'Temporary file and lock cleaned after rejection');
    await writeFile(path.join(root, `${taskDirectory}/.dashboard-write.lock`), '');
    await assert.rejects(editTask(root, task.note, snapshot.token, { kind: 'notes', content: 'Draft' }), /Another dashboard write/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('legacy and identified memory files retain their ownership protections', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-legacy-edit-'));
  try {
    await mkdir(path.join(root, taskDirectory), { recursive: true });
    const note = `${taskDirectory}/legacy.md`;
    await writeFile(path.join(root, note), '# Legacy\n');
    let snapshot = await taskSnapshot(root, note);
    await assert.rejects(editTask(root, note, snapshot.token, { kind: 'archive', archived: true }), /Adopt this legacy task/);
    await editTask(root, note, snapshot.token, { kind: 'notes', content: '# Legacy\nNew finding\n' });
    await writeFile(path.join(root, note), '<!-- AIOS-ENTRY protected -->\n');
    snapshot = await taskSnapshot(root, note);
    await assert.rejects(editTask(root, note, snapshot.token, { kind: 'notes', content: 'Removed entry' }), /amendment process/);
    await assert.rejects(taskSnapshot(root, '.ai-os/BOOT.md'), /working task/);
    await assert.rejects(taskSnapshot(root, `${taskDirectory}/../outside.md`), /working task/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('mutation message validation rejects oversized drafts, forged fields and invalid state', () => {
  const reference = { id: 'task', revision: 1, token: 'a'.repeat(64) };
  assert.equal(parseDashboardMessage({ type: 'saveNotes', ...reference, content: 'Note' }).type, 'saveNotes');
  assert.equal(parseDashboardMessage({ type: 'archiveTask', ...reference, archived: true }).type, 'archiveTask');
  for (const value of [
    { type: 'saveNotes', ...reference, content: 'x'.repeat(256001) },
    { type: 'saveNotes', ...reference, content: 'Note', path: '/secret' },
    { type: 'saveProperties', ...reference, title: 'Task', status: 'parked' },
    { type: 'saveProperties', ...reference, title: 'Task\nBranch: x', status: 'open' },
    { type: 'archiveTask', ...reference, archived: 'true' },
  ]) assert.throws(() => parseDashboardMessage(value));
});
