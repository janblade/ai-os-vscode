import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { createFile, readText, safePath, missing } from '../core/files';
import { readAgent } from './agents';
import { readBinding, sidecar, taskDirectory, archiveDirectory } from './tasks';

export interface TaskSnapshot { content: string; properties: string | null; token: string }
export type TaskEdit = { kind: 'notes'; content: string }
  | { kind: 'properties'; title: string; status: 'open' | 'inProgress' | 'done'; agentId?: string | null }
  | { kind: 'archive'; archived: boolean };
const LIMIT = 256000;
const COMMIT_ATTEMPTS = 5;
const BUSY_DELAY_MS = 50;
function validateNote(note: string): void {
  const directory = note.startsWith(archiveDirectory + '/') ? archiveDirectory : taskDirectory;
  if (!note.startsWith(`${directory}/`) || note.slice(directory.length + 1).includes('/') || !note.endsWith('.md')) throw new Error('Choose a working task Markdown file.');
}
export async function taskSnapshot(root: string, note: string): Promise<TaskSnapshot> {
  validateNote(note);
  const content = await readText(root, note, LIMIT);
  let properties: string | null = null;
  try { properties = await readText(root, sidecar(note), LIMIT); }
  catch (error) {
    if (!missing(error)) throw error;
    const binding = await readBinding(root, note); properties = binding ? JSON.stringify(binding) : null;
  }
  const token = createHash('sha256').update(JSON.stringify([content, properties])).digest('hex');
  return { content, properties, token };
}
function replacement(snapshot: TaskSnapshot, edit: TaskEdit): string {
  if (edit.kind === 'notes') {
    if (Buffer.byteLength(edit.content, 'utf8') > LIMIT) throw new Error('Task notes exceed 256 KB.');
    if (snapshot.content.includes('<!-- AIOS-ENTRY') || edit.content.includes('<!-- AIOS-ENTRY')) throw new Error('Identified memory entries require the memory amendment process.');
    const headers = (text: string) => text.match(/^(?:Task-ID|Branch):[^\r\n]*/gm) ?? [];
    if (JSON.stringify(headers(snapshot.content)) !== JSON.stringify(headers(edit.content))) throw new Error('Preserve the task identity and Branch headers.');
    return edit.content;
  }
  if (snapshot.properties === null) throw new Error('Adopt this legacy task before editing properties or archiving it.');
  const value = JSON.parse(snapshot.properties);
  if (edit.kind === 'properties') {
    if (!edit.title.trim() || edit.title.length > 200 || /[\r\n]/.test(edit.title) || !['open', 'inProgress', 'done'].includes(edit.status)) throw new Error('Enter a single-line title and valid task state.');
    value.title = edit.title; value.status = edit.status;
    if (edit.agentId === null) delete value.agentId;
    else if (edit.agentId !== undefined) value.agentId = edit.agentId;
  } else { value.archived = edit.archived; }
  return JSON.stringify(value, null, 2) + '\n';
}
/** One file per operation: preserve the other file and reject edits based on stale pairs. */
export async function editTask(root: string, note: string, token: string, edit: TaskEdit, validate: (transientFiles: string[]) => Promise<void> = async () => {}): Promise<void> {
  validateNote(note);
  const lockPath = await safePath(root, `${taskDirectory}/.dashboard-write.lock`);
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('Another dashboard write is active. A stale lock requires manual inspection.'); throw error; }
  let temporary: string | undefined;
  try {
    await validate([`${taskDirectory}/.dashboard-write.lock`]);
    const snapshot = await taskSnapshot(root, note);
    if (snapshot.token !== token) throw new Error('Task changed on disk. Your draft was preserved; reload before saving.');
    await readBinding(root, note); // Invalid bindings are never rewritten implicitly.
    if (edit.kind === 'properties' && edit.agentId) await readAgent(root, edit.agentId);
    const text = replacement(snapshot, edit);
    const target = edit.kind === 'notes' ? note : sidecar(note);
    temporary = `${target}.${randomUUID()}.tmp`;
    await createFile(root, temporary, text);
    await commit(root, note, token, temporary, target, validate);
    temporary = undefined;
  } finally {
    try { if (temporary) await unlink(await safePath(root, temporary)); }
    finally { await lock.close(); await unlink(lockPath); }
  }
}

async function commit(root: string, note: string, token: string, temporary: string, target: string, validate: (transientFiles: string[]) => Promise<void>): Promise<void> {
  for (let attempt = 0; attempt < COMMIT_ATTEMPTS; attempt++) {
    await validate([`${taskDirectory}/.dashboard-write.lock`, temporary]);
    if ((await taskSnapshot(root, note)).token !== token) throw new Error('Task changed on disk. Your draft was preserved; reload before saving.');
    try {
      // shortcut: external writers do not honor this lock; hashes detect changes before commit, not hostile races during rename.
      await rename(await safePath(root, temporary), await safePath(root, target)); return;
    } catch (error) {
      if (!['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      if (attempt === COMMIT_ATTEMPTS - 1) throw new Error('Task file is busy or inaccessible. No edit was committed; keep your draft and try again.');
      await new Promise(resolve => setTimeout(resolve, BUSY_DELAY_MS));
    }
  }
}
