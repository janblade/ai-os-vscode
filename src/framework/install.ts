import { createHash } from 'node:crypto';
import { mkdir, lstat, unlink } from 'node:fs/promises';
import { createFile, missing, readText, safePath } from '../core/files';

export interface FrameworkPayload {
  format: 1; commit: string; version: string;
  files: { path: string; content: string; sha256: string }[];
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
export async function initializeFramework(root: string, payload: FrameworkPayload): Promise<void> {
  if (payload.format !== 1 || !/^[a-f0-9]{40}$/.test(payload.commit) || !Array.isArray(payload.files) || !payload.files.length) throw new Error('Invalid bundled framework.');
  const paths = new Set<string>();
  for (const file of payload.files) {
    await safePath(root, `.ai-os/${file.path}`);
    if (file.path === '.installing.json' || paths.has(file.path.toLowerCase()) || typeof file.content !== 'string' || digest(file.content) !== file.sha256) throw new Error('Invalid bundled file or checksum.');
    paths.add(file.path.toLowerCase());
  }
  if (!paths.has('manifest.json') || !paths.has('boot.md')) throw new Error('Incomplete framework bundle.');
  const bundle = digest(JSON.stringify(payload));
  const marker = '.ai-os/.installing.json';
  const receipt = JSON.stringify({ format: 1, commit: payload.commit, bundle }) + '\n';
  let resumed = false;
  try { await mkdir(await safePath(root, '.ai-os')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    let existing: string;
    try { existing = await readText(root, marker); } catch { throw new Error('An existing .ai-os is present. Initialization will not replace it. Select it or inspect it first.'); }
    if (existing !== receipt) throw new Error('This partial installation belongs to a different bundle. No files were changed.');
    resumed = true;
  }
  if (!resumed) await createFile(root, marker, receipt);
  // A failed installation retains its receipt; retry fills only missing, checksum-matching files.
  for (const file of payload.files) {
    const relative = `.ai-os/${file.path}`;
    try {
      await lstat(await safePath(root, relative));
      if (digest(await readText(root, relative, 2000000)) !== file.sha256) throw new Error(`Installation conflict at ${file.path}. Existing content was preserved.`);
    } catch (error) {
      if (!missing(error)) throw error;
      await createFile(root, relative, file.content);
    }
  }
  await unlink(await safePath(root, marker));
}
