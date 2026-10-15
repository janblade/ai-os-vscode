import { lstat, mkdir, open, readFile, realpath, rename, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export function missing(error: unknown): boolean { return (error as NodeJS.ErrnoException)?.code === 'ENOENT'; }

export function validateRelativePath(relative: string): string[] {
  const parts = relative.split('/');
  if (!relative || parts.some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) throw new Error(`Unsafe workspace path: ${JSON.stringify(relative).slice(0, 300)}. Expected a relative file path with forward slashes and no empty, reserved or traversal components.`);
  return parts;
}
/** Reject linked components, including Windows junctions, before workspace I/O. */
export async function safePath(root: string, relative: string): Promise<string> {
  const parts = validateRelativePath(relative);
  const resolvedRoot = await realpath(root);
  let cursor = resolvedRoot;
  for (const part of parts) {
    cursor = path.join(cursor, part);
    try {
      const stat = await lstat(cursor);
      if (stat.isSymbolicLink()) throw new Error('Linked workspace paths are not supported.');
    } catch (error) { if (!missing(error)) throw error; }
  }
  return cursor;
}

export async function createFile(root: string, relative: string, text: string): Promise<void> {
  let file = await safePath(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  file = await safePath(root, relative);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}

export async function readText(root: string, relative: string, limit = 256000): Promise<string> {
  const file = await safePath(root, relative);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > limit) throw new Error('File is not a regular file or exceeds the size limit.');
  return readFile(file, 'utf8');
}

export async function listFiles(root: string, relative: string): Promise<string[]> {
  try {
    const directory = await safePath(root, relative);
    return (await readdir(directory, { withFileTypes: true }))
      .filter(entry => entry.isFile() && !entry.isSymbolicLink()).map(entry => `${relative}/${entry.name}`).sort();
  } catch (error) { if (missing(error)) return []; throw error; }
}

export async function atomicJson(root: string, relative: string, value: unknown): Promise<void> {
  const target = await safePath(root, relative);
  const temporary = `${relative}.${randomUUID()}.tmp`;
  await createFile(root, temporary, JSON.stringify(value, null, 2) + '\n');
  try {
    for (let attempt = 0; ; attempt++) {
      try { await rename(await safePath(root, temporary), target); break; }
      catch (error) {
        // Windows readers and antivirus can briefly hold the destination open.
        if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)));
      }
    }
  }
  catch (error) { await unlink(await safePath(root, temporary)).catch(() => {}); throw error; }
}
