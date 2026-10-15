import path from 'node:path';
import { safePath } from '../core/files';
const protectedNames = ['BOOT.md', 'manifest.json', 'kernel', 'rules', 'genome/archetypes'];
const hostNames = ['.git', '.codex', '.claude', '.gemini', '.copilot'];
const userNames = ['memory/proposals', 'registry', 'commands', 'agents', 'workflows', 'progress.md', 'genome/project_genome.json'];
export function userPaths(root: string): string[] { return userNames.map(name => path.join(root, '.ai-os', name)); }
export function memoryPaths(root: string): string[] { return ['tasks', 'archived_tasks', 'semantic', 'procedural', 'plans', 'episodic', 'runtime'].map(name => path.join(root, '.ai-os/memory', name)); }
export function kernelPaths(root: string): string[] { return protectedNames.map(name => path.join(root, '.ai-os', name)); }
export function permissionProfile(framework: string, readOnly = false): object {
  if (readOnly) return { extends: ':read-only' };
  return { extends: ':workspace', filesystem: { ':tmpdir': 'read', ':slash_tmp': 'read', ':workspace_roots': Object.fromEntries([...protectedNames, 'memory', ...['tasks', 'archived_tasks', 'semantic', 'procedural', 'plans', 'episodic', 'runtime'].map(name => `memory/${name}`)].map(name => [`.ai-os/${name}`, 'read']).concat(hostNames.map(name => [name, 'read']))),
    ...Object.fromEntries(userPaths(framework).map(name => [name.replaceAll('\\', '/'), 'write'])),
    ...Object.fromEntries([...kernelPaths(framework), ...memoryPaths(framework), path.join(framework, '.ai-os/memory'), ...hostNames.map(name => path.join(framework, name))].map(name => [name.replaceAll('\\', '/'), 'read'])) } };
}
export function inlineToml(value: unknown): string {
  if (typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('Invalid permission profile value.');
  return '{' + Object.entries(value).map(([key, item]) => `${JSON.stringify(key)}=${inlineToml(item)}`).join(',') + '}';
}
export async function validateEditPath(repository: string, framework: string, input: unknown): Promise<void> {
  if (typeof input !== 'string' || !input) throw new Error('File edit has no verifiable path.');
  const target = path.resolve(repository, input);
  const inside = (root: string) => { const delta = path.relative(root, target); return delta === '' || (delta !== '..' && !delta.startsWith('..' + path.sep) && !path.isAbsolute(delta)); };
  const root = inside(repository) ? repository : userPaths(framework).some(inside) ? framework : undefined;
  if (!root) throw new Error('File edit is outside the selected repository and AI OS user space.');
  for (const directory of [repository, framework]) {
    const memory = path.relative(path.join(directory, '.ai-os/memory'), target);
    if (memory === '' || (memory !== '..' && !memory.startsWith('..' + path.sep) && !path.isAbsolute(memory))) {
      const proposal = path.relative(path.join(directory, '.ai-os/memory/proposals'), target);
      if (proposal === '' || proposal === '..' || proposal.startsWith('..' + path.sep) || path.isAbsolute(proposal)) throw new Error('Memory changes require an explicit reviewed proposal.');
    }
  }
  const relative = path.relative(root, target);
  if (!relative) throw new Error('File edit cannot replace a root directory.');
  await safePath(root, relative.split(path.sep).join('/'));
  const roots = [...kernelPaths(repository), ...kernelPaths(framework), ...memoryPaths(repository), ...memoryPaths(framework), ...[repository, framework].flatMap(directory => hostNames.map(name => path.join(directory, name)))];
  if (roots.some(root => { const delta = path.relative(root, target); return delta === '' || (delta !== '..' && !delta.startsWith('..' + path.sep) && !path.isAbsolute(delta)); })) throw new Error('Protected framework or host configuration requires its existing authorization flow.');
}

export async function validatePermissions(repository: string, framework: string, permissions: any): Promise<void> {
  const fs = permissions?.fileSystem;
  const validate = async (file: unknown) => {
    await validateEditPath(repository, framework, file);
    const target = path.resolve(repository, file as string);
    for (const protectedPath of [...kernelPaths(repository), ...kernelPaths(framework), ...memoryPaths(repository), ...memoryPaths(framework), ...[repository, framework].flatMap(directory => hostNames.map(name => path.join(directory, name)))]) {
      const delta = path.relative(target, protectedPath);
      if (delta === '' || (delta !== '..' && !delta.startsWith('..' + path.sep) && !path.isAbsolute(delta))) throw new Error('Expanded permission would include protected paths.');
    }
  };
  for (const file of fs?.write ?? []) await validate(file);
  for (const entry of fs?.entries ?? []) {
    if (entry.access !== 'write') continue;
    if (entry.path?.type !== 'path') throw new Error('Expanded write patterns require a separate human authorization flow.');
    await validate(entry.path.path);
  }
}

export async function validateScope(repository: string, framework: string): Promise<void> {
  for (const root of new Set([repository, framework])) {
    for (const file of [...kernelPaths(root), ...userPaths(root)]) await safePath(root, path.relative(root, file).split(path.sep).join('/'));
  }
}

export function claudeTools(platform: NodeJS.Platform, readOnly = false, discovery = false): string[] {
  return readOnly ? (discovery ? ['Read', 'Glob', 'Grep', 'AskUserQuestion'] : []) : ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'NotebookEdit', 'AskUserQuestion', 'TodoWrite', ...(platform === 'win32' ? [] : ['Bash'])];
}
