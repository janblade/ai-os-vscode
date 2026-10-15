import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { safePath, validateRelativePath } from './files';
export interface RepositoryReview { token: string; branch: string; head: string; status: string; stagedDiff: string; diff: string; untracked: string[] }
/** Current working tree, not a claim that this run caused every change. No model egress. */
export async function repositoryReview(repository: string, transientFiles: string[] = []): Promise<RepositoryReview> {
  return reviewRepository(repository, transientFiles, { files: 0, bytes: 0, repositories: 0 }, 0);
}
async function reviewRepository(repository: string, transientFiles: string[], budget: { files: number; bytes: number; repositories: number }, depth: number): Promise<RepositoryReview> {
  if (depth > 4 || ++budget.repositories > 32) throw new Error('Too many nested repositories for review. Review them separately.');
  const git = async (...args: string[]) => (await promisify(execFile)('git', ['--no-pager', '-c', 'core.fsmonitor=false', ...args], { cwd: repository, windowsHide: true, timeout: 10000, maxBuffer: 2000000 })).stdout;
  transientFiles.forEach(validateRelativePath);
  if (depth > 0 && path.relative(await realpath(repository), await realpath((await git('rev-parse', '--show-toplevel')).trim())) !== '') throw new Error('Nested review target must be its own Git repository.');
  const statusText = async () => (await git('status', '--porcelain=v1', '-z', '--untracked-files=all')).split('\0').filter(record => !transientFiles.some(file => record === '?? ' + file)).join('\0');
  const head = (await git('rev-parse', 'HEAD')).trim();
  const branch = (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim();
  const status = await statusText();
  const submodules = await git('status', '--porcelain=v2', '-z', '--ignore-submodules=none');
  if (submodules.split('\0').some(record => /^[12] \S+ S.[MU]/.test(record) || /^[12] \S+ S..U/.test(record))) throw new Error('Dirty submodule content needs a separate review before accepting the parent repository.');
  const diff = await git('diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--');
  const stagedDiff = await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--');
  const names = (await git('ls-files', '--others', '--exclude-standard', '-z')).split('\0').filter(name => name && !transientFiles.includes(name));
  budget.files += names.length;
  if (budget.files > 1000) throw new Error('Too many untracked files for review. Review or narrow the repository first.');
  const digest = createHash('sha256').update(JSON.stringify([head, branch, status, diff, stagedDiff]));
  const nestedDetails: string[] = [];
  for (const name of names) {
    // Git emits embedded untracked repositories as directory/ rather than their files.
    const file = await safePath(repository, name.endsWith('/') ? name.slice(0, -1) : name); const stat = await lstat(file);
    if (name.endsWith('/') && stat.isDirectory()) {
      const nested = await reviewRepository(file, [], budget, depth + 1);
      digest.update(name).update(nested.token);
      nestedDetails.push(`Nested repository: ${name}\nHEAD: ${nested.head}\nBranch: ${nested.branch}\n${nested.status}\n${nested.diff}\nStaged changes:\n${nested.stagedDiff}\nUntracked files:\n${nested.untracked.join('\n')}`);
      continue;
    }
    budget.bytes += stat.size;
    if (!stat.isFile() || budget.bytes > 16000000) throw new Error('Untracked content exceeds the review limit or is not a regular file. Review it separately first.');
    digest.update(name).update(await readFile(file));
  }
  // A second pass rejects ordinary concurrent tracked changes; hostile filesystem races are outside this review receipt.
  if (stagedDiff !== await git('diff', '--cached', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--') || branch !== (await git('rev-parse', '--abbrev-ref', 'HEAD')).trim() || head !== (await git('rev-parse', 'HEAD')).trim() || status !== await statusText() || diff !== await git('diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD', '--')) throw new Error('Repository changed while preparing review. Refresh and try again.');
  return { token: digest.digest('hex'), head, branch, stagedDiff, status: status.replaceAll('\0', '\n'), diff: [diff, ...nestedDetails].filter(Boolean).join('\n\n'), untracked: names };
}
