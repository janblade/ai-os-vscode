import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { execFile } from 'node:child_process';
export async function sessionIdentity(repository: string, taskId?: string): Promise<{ repositoryId: string; branch: string | null; taskId?: string; sessionName: string | null }> {
  const root = await realpath(repository);
  const repositoryId = createHash('sha256').update(process.platform === 'win32' ? root.toLowerCase() : root).digest('hex');
  const branch = await new Promise<string | null>(resolve => execFile('git', ['-C', root, 'symbolic-ref', '--quiet', '--short', 'HEAD'], { windowsHide: true, timeout: 5000, maxBuffer: 8192 }, (error, text) => resolve(error ? null : text.trim())));
  return { repositoryId, branch, taskId, sessionName: branch ? `repo:${repositoryId}|task:${taskId ?? ''}|branch:${branch}` : null };
}
