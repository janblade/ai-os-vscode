import path from 'node:path';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { missing, readText, safePath } from '../core/files';

export interface FrameworkCandidate { root: string; status: 'ready' | 'incomplete' | 'invalid'; detail?: string; version?: string }
export interface RepositoryTarget { folder: string; path: string }
export function inside(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}
export async function inspectFramework(root: string): Promise<FrameworkCandidate | undefined> {
  try { await lstat(path.join(root, '.ai-os')); } catch (error) { if (missing(error)) return undefined; throw error; }
  try {
    await safePath(root, '.ai-os');
    try {
      await lstat(await safePath(root, '.ai-os/.installing.json'));
      return { root, status: 'incomplete', detail: 'Initialization was interrupted. Use Initialize to resume.' };
    } catch (error) { if (!missing(error)) throw error; }
    const manifest = JSON.parse(await readText(root, '.ai-os/manifest.json'));
    if (typeof manifest.ai_os_version !== 'string' || !manifest.ai_os_version) throw new Error('Missing framework version.');
    await readText(root, '.ai-os/BOOT.md');
    return { root, status: 'ready', version: manifest.ai_os_version };
  } catch (error) { return { root, status: 'invalid', detail: String(error) }; }
}
export async function discoverFrameworks(folders: string[], workspaceFile?: string): Promise<FrameworkCandidate[]> {
  const locations = [...folders, ...(workspaceFile ? [path.dirname(workspaceFile)] : [])];
  const seen = new Set<string>(); const result: FrameworkCandidate[] = [];
  for (const location of locations) {
    let root: string;
    try { root = await realpath(location); } catch (error) { if (missing(error)) continue; throw error; }
    if (seen.has(root)) continue;
    seen.add(root);
    const candidate = await inspectFramework(root); if (candidate) result.push(candidate);
  }
  return result;
}
export async function repositoryTargets(folders: string[]): Promise<RepositoryTarget[]> {
  const result: RepositoryTarget[] = [];
  for (const folder of folders) {
    try {
      const uri = pathToFileURL(await realpath(folder)).href;
      result.push({ folder: uri, path: '.' });
      for (const child of await readdir(folder, { withFileTypes: true })) {
        if (!child.isDirectory() || child.isSymbolicLink() || child.name.startsWith('.')) continue;
        try {
          await lstat(await safePath(folder, `${child.name}/.git`));
          result.push({ folder: uri, path: child.name });
        } catch (error) { if (!missing(error)) throw error; }
      }
    } catch (error) { if (!missing(error)) throw error; }
  }
  return result;
}
export async function resolveRepository(frameworkRoot: string, target: string | RepositoryTarget, folders: string[]): Promise<string> {
  const allowed: string[] = [];
  for (const folder of folders) {
    try { allowed.push(await realpath(folder)); } catch (error) { if (!missing(error)) throw error; }
  }
  let resolved: string;
  if (typeof target === 'string') {
    resolved = target === '.' ? await realpath(frameworkRoot) : await safePath(frameworkRoot, target);
    if (!allowed.some(root => inside(root, resolved))) throw new Error('Repository is no longer included in this workspace. Add its folder or rebind the task.');
  } else {
    if (typeof target.folder !== 'string' || !target.folder.startsWith('file:') || typeof target.path !== 'string') throw new Error('Invalid repository binding.');
    const requested = fileURLToPath(target.folder);
    // Match before filesystem access: stored bindings cannot authorize new directories.
    const folder = allowed.find(folder => path.relative(folder, requested) === '');
    if (!folder) throw new Error('Repository folder is no longer included in this workspace. Add it or rebind the task.');
    resolved = target.path === '.' ? folder : await safePath(folder, target.path);
  }
  if (!(await lstat(resolved)).isDirectory()) throw new Error('Repository directory is unavailable.');
  return resolved;
}
export async function detectedConfiguration(root: string): Promise<string[]> {
  const names: string[] = [];
  for (const name of ['.ai-os', 'CLAUDE.md', '.claude/CLAUDE.md', '.claude/settings.json', '.claude/settings.local.json', '.claude/rules']) {
    try { await lstat(await safePath(root, name)); names.push(name); }
    catch (error) { if (!missing(error)) throw error; }
  }
  return names;
}
