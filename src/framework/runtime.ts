import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { object } from '../contracts';
import { validateRelativePath } from '../core/files';

const protocol = 'AIOS-runtime/1';
export interface ContextItem {
  id: string; scope: 'framework' | 'repository'; source: string; sha256: string;
  kind: 'governance' | 'procedure' | 'data'; reason: string; content: string;
}
export interface ContextPack {
  format: 'AIOS-bound-context/1'; framework_version: string;
  frameworkRoot: string; repositoryRoot: string; task: string | null; items: ContextItem[];
}
export interface ContextRequest { frameworkRoot: string; repositoryRoot: string; task: string | null; files: string[] }

export function parseContext(value: unknown, expected: ContextRequest): ContextPack {
  const pack = object(value);
  if (pack.format !== 'AIOS-bound-context/1' || typeof pack.framework_version !== 'string'
    || typeof pack.frameworkRoot !== 'string' || !path.isAbsolute(pack.frameworkRoot) || path.relative(pack.frameworkRoot, expected.frameworkRoot)
    || typeof pack.repositoryRoot !== 'string' || !path.isAbsolute(pack.repositoryRoot) || path.relative(pack.repositoryRoot, expected.repositoryRoot)
    || pack.task !== expected.task || !Array.isArray(pack.items) || pack.items.length > 64) throw new Error('Invalid context binding or format.');
  const ids = new Set<string>();
  for (const raw of pack.items) {
    const item = object(raw);
    if (!['framework', 'repository'].includes(item.scope as string) || typeof item.source !== 'string'
      || item.id !== `${item.scope}:${item.source}` || ids.has(item.id as string)
      || !['governance', 'procedure', 'data'].includes(item.kind as string)
      || typeof item.reason !== 'string' || typeof item.content !== 'string' || typeof item.sha256 !== 'string') throw new Error('Invalid context source.');
    validateRelativePath(item.source);
    if (item.kind !== (item.scope === 'framework' && item.source === '.ai-os/BOOT.md' ? 'governance' : 'data')) throw new Error('Unexpected context source role.');
    ids.add(item.id as string);
    const hashes = [item.content, '\uFEFF' + item.content].map(text => createHash('sha256').update(text).digest('hex'));
    if (!hashes.includes(item.sha256)) throw new Error('Context source checksum mismatch.');
    if (item.scope === 'repository' && (!expected.files.includes(item.source) || item.kind !== 'data')) throw new Error('Unexpected repository context.');
    if (item.scope === 'framework' && item.source !== '.ai-os/BOOT.md' && item.source !== expected.task
      && !item.source.startsWith('.ai-os/memory/plans/')) throw new Error('Unexpected framework context.');
  }
  if (pack.items[0]?.id !== 'framework:.ai-os/BOOT.md' || pack.items[0]?.kind !== 'governance'
    || (expected.task && !ids.has(`framework:${expected.task}`))
    || expected.files.some(file => !ids.has(`repository:${file}`))) throw new Error('Context is missing required sources.');
  return pack as unknown as ContextPack;
}

export async function runtimeRequest(script: string, operation: 'capabilities' | 'context.preview', params: object): Promise<unknown> {
  const id = randomUUID();
  const request = JSON.stringify({ protocol, id, operation, params });
  if (Buffer.byteLength(request) > 65536) throw new Error('Context request exceeds 64 KiB.');
  return new Promise((resolve, reject) => {
    const child = execFile(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', script], {
      cwd: path.dirname(script), encoding: 'utf8', timeout: 10000, maxBuffer: 2 * 1024 * 1024, windowsHide: true,
    }, (error, stdout) => {
      try {
        if (error && error.code !== 2) throw new Error(`Context runtime failed (${error.code ?? 'process stopped'}). Python 3.9+ must be available on PATH.`);
        const response = object(JSON.parse(stdout));
        if (response.protocol !== protocol || response.id !== id || typeof response.ok !== 'boolean') throw new Error('Invalid runtime response.');
        if (!response.ok) {
          const failure = object(response.error);
          throw new Error(typeof failure.message === 'string' ? failure.message.slice(0, 1000) : 'Context runtime rejected the request.');
        }
        if (error) throw new Error('Runtime exit status disagrees with its response.');
        resolve(response.result);
      } catch (failure) { reject(failure); }
    });
    child.stdin?.on('error', reject);
    child.stdin?.end(request);
  });
}

export async function previewContext(script: string, request: ContextRequest): Promise<ContextPack> {
  const capabilities = object(await runtimeRequest(script, 'capabilities', {}));
  if (!Array.isArray(capabilities.operations) || !capabilities.operations.includes('context.preview')
    || capabilities.contextFormat !== 'AIOS-bound-context/1' || capabilities.memoryMutation !== false
    || capabilities.commandExecution !== false || capabilities.hookInstallation !== false) throw new Error('Unsupported runtime capabilities.');
  return parseContext(await runtimeRequest(script, 'context.preview', request), request);
}
