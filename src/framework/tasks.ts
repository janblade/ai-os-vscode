import { randomUUID } from 'node:crypto';
import { createFile, listFiles, readText, safePath, missing, validateRelativePath } from '../core/files';
import { object } from '../contracts';
import { lstat } from 'node:fs/promises';
import { readAgent, validAgentId } from './agents';
import { RepositoryTarget, resolveRepository } from './workspace';

export interface TaskBinding {
  version: 1 | 2; id: string; title: string; status: 'open' | 'inProgress' | 'done';
  note: string; repository: string | RepositoryTarget; assignedProvider?: 'mock'; agentId?: string; archived?: boolean;
}
export const archiveDirectory = '.ai-os/memory/archived_tasks';
export const taskDirectory = '.ai-os/memory/tasks';
export function sidecar(note: string): string { return note.replace(/\.md$/, '.task.json'); }

export async function readBinding(root: string, note: string): Promise<TaskBinding | undefined> {
  try {
    let text: string;
    try { text = await readText(root, sidecar(note)); }
    catch (error) {
      if (!missing(error) || !note.startsWith(archiveDirectory + '/')) throw error;
      text = await readText(root, sidecar(note.replace(archiveDirectory + '/', taskDirectory + '/')));
    }
    const value = object(JSON.parse(text));
    if (note.startsWith(archiveDirectory + '/') && value.note === note.replace(archiveDirectory + '/', taskDirectory + '/')) { value.note = note; value.archived = true; }
    if (![1, 2].includes(value.version as number) || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || value.note !== note || typeof value.title !== 'string' || !['open', 'inProgress', 'done'].includes(value.status as string)) throw new Error(`Invalid task binding: ${sidecar(note)}`);
    if (value.agentId !== undefined && !validAgentId(value.agentId)) throw new Error('Invalid task agent ID.');
    if (value.archived !== undefined && typeof value.archived !== 'boolean') throw new Error('Invalid task archive flag.');
    if (value.version === 1) {
      if (typeof value.repository !== 'string') throw new Error('Invalid legacy repository binding.');
      if (value.repository !== '.') await safePath(root, value.repository);
    } else {
      const target = object(value.repository);
      if (typeof target.folder !== 'string' || !target.folder.startsWith('file:') || typeof target.path !== 'string') throw new Error('Invalid workspace repository binding.');
      if (target.path !== '.') validateRelativePath(target.path);
    }
    return value as unknown as TaskBinding;
  } catch (error) { if (missing(error)) return undefined; throw error; }
}

async function validateTarget(root: string, repository: string | RepositoryTarget, folders?: string[]): Promise<void> {
  if (typeof repository !== 'string') { await resolveRepository(root, repository, folders ?? []); return; }
  if (repository !== '.' && !(await lstat(await safePath(root, repository))).isDirectory()) throw new Error('Repository must be a directory.');
}
export async function adoptTask(root: string, note: string, title: string, repository: string | RepositoryTarget, folders?: string[], agentId?: string, id: string = randomUUID()): Promise<TaskBinding> {
  if (!note.startsWith(`${taskDirectory}/`) || note.slice(taskDirectory.length + 1).includes('/') || !note.endsWith('.md')) throw new Error('Choose a task Markdown file.');
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Invalid task identity.');
  await readText(root, note);
  await validateTarget(root, repository, folders);
  if (!title.trim() || title.length > 200) throw new Error('Task title must contain 1–200 characters.');
  if (agentId) await readAgent(root, agentId);
  const binding: TaskBinding = { version: typeof repository === 'string' ? 1 : 2, id, title, status: 'open', note, repository, ...(agentId ? { agentId } : {}) };
  await createFile(root, sidecar(note), JSON.stringify(binding, null, 2) + '\n');
  return binding;
}

export async function createTask(root: string, title: string, repository: string | RepositoryTarget, folders?: string[], initial: { notes?: string; agentId?: string } = {}): Promise<TaskBinding> {
  if (!title.trim() || title.length > 200 || /[\r\n]/.test(title)) throw new Error('Enter a single-line task title (1–200 characters).');
  await validateTarget(root, repository, folders);
  if (initial.notes !== undefined && (typeof initial.notes !== 'string' || Buffer.byteLength(initial.notes) > 200000)) throw new Error('Initial notes exceed 200 KB.');
  if (initial.agentId) await readAgent(root, initial.agentId);
  const id = randomUUID();
  const note = `${taskDirectory}/task-${id}.md`;
  await createFile(root, note, `# ${title}\n\nTask-ID: ${id}\n\n## Working notes\n\n${initial.notes ?? ''}${initial.notes ? '\n' : ''}`);
  // shortcut: two new files, a failed sidecar write leaves a usable unbound note for explicit adoption.
  return adoptTask(root, note, title, repository, folders, initial.agentId, id);
}

export async function tasks(root: string): Promise<string[]> {
  return [...await listFiles(root, taskDirectory), ...await listFiles(root, archiveDirectory)].filter(file => file.endsWith('.md'));
}

export async function taskEntries(root: string): Promise<{ note: string; binding?: TaskBinding; error?: string }[]> {
  return Promise.all((await tasks(root)).map(async note => {
    try { return { note, binding: await readBinding(root, note) }; }
    catch (error) { return { note, error: String(error) }; }
  }));
}

export const capabilities = {
  fileTasks: true, workflowVersion: 1, providers: ['mock', 'codex', 'claude'],
  contextPacks: true, memoryTransactions: false, existingSessionTakeover: false,
} as const;
