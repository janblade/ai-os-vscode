import { inside } from '../framework/workspace';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { mkdtemp, readdir, rm, writeFile, rename, unlink, stat, chmod, realpath } from 'node:fs/promises';
import { WorkflowNode } from '../contracts';
import { readText, safePath, missing, createFile } from '../core/files';
import { AgentProvider } from './mock';
import { ExecutionContext, executionPrompt } from './context';
import { validateEditPath, validatePermissions, validateScope } from './boundaries';
import { RpcProcess } from './rpc';

export type AcpProviderId = 'gemini' | 'copilot';
export function acpArguments(provider: AcpProviderId, readOnly: boolean, policy?: string, model?: string): string[] {
  const args = provider === 'gemini' ? ['--acp', '--approval-mode=default', '--admin-policy', policy!] : ['--acp', '--stdio', `--available-tools=${readOnly ? 'view' : 'view,create,edit'}`];
  if (model) args.push('--model', model);
  return args;
}
export function geminiPolicy(readOnly: boolean): string {
  const tools = ['read_file', 'read_many_files', 'list_directory', 'glob', 'grep_search', ...(readOnly ? [] : ['write_file', 'replace'])];
  return `[[rule]]\ntoolName = "*"\ndecision = "deny"\npriority = 998\n\n[[rule]]\ntoolName = ${JSON.stringify(tools)}\ndecision = "ask_user"\npriority = 999\n`;
}
async function boundPath(context: ExecutionContext, file: unknown): Promise<{ root: string; relative: string; file: string }> {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('ACP requires an absolute file path.');
  for (const root of new Set([context.repository, context.frameworkRoot])) {
    if (!inside(root, file)) continue;
    const relative = path.relative(root, file).split(path.sep).join('/');
    return { root, relative, file: relative ? await safePath(root, relative) : await realpath(root) };
  }
  throw new Error('File is outside the bound repository and framework.');
}
async function readBound(context: ExecutionContext, file: unknown): Promise<string> {
  const target = await boundPath(context, file);
  return readText(target.root, target.relative);
}
export class AcpProvider implements AgentProvider {
  readonly capabilities = { cancellation: true, resume: false, toolApprovals: true };
  constructor(readonly id: AcpProviderId, private executable: string, private transport = (command: string, args: string[], cwd: string) => {
    const script = /\.(?:c?js|mjs)$/i.test(command);
    return new RpcProcess(script ? process.execPath : command, script ? [command, ...args] : args, cwd, { ...process.env, ...(script ? { ELECTRON_RUN_AS_NODE: '1' } : {}) }, true);
  }) {}
  async execute(node: WorkflowNode, signal: AbortSignal, context?: ExecutionContext): Promise<string> {
    if (!context) throw new Error('ACP execution requires a bound context.');
    await context.validate(); await validateScope(context.repository, context.frameworkRoot); signal.throwIfAborted();
    let temporary: string | undefined; let rpc: RpcProcess | undefined; let sessionId: string | undefined; let text = ''; let failure: Error | undefined;
    let interactions = Promise.resolve();
    const abort = () => { void rpc?.close().catch(() => {}); };
    signal.addEventListener('abort', abort, { once: true });
    try {
      let policy: string | undefined;
      if (this.id === 'gemini') {
        const central = process.platform === 'win32' ? path.join(process.env.ProgramData ?? 'C:/ProgramData', 'gemini-cli/policies') : process.platform === 'darwin' ? '/Library/Application Support/GeminiCli/policies' : '/etc/gemini-cli/policies';
        try { if ((await readdir(central)).some(file => file.toLowerCase().endsWith('.toml'))) throw new Error('Managed Gemini policies need a separately verified connector policy; the local policy must not override them.'); } catch (error) { if (!missing(error)) throw error; }
        temporary = await mkdtemp(path.join(os.tmpdir(), 'aios-gemini-')); policy = path.join(temporary, 'policy.toml');
        await writeFile(policy, geminiPolicy(Boolean(context.readOnly)), { mode: 0o600 });
      }
      signal.throwIfAborted();
      rpc = this.transport(this.executable, acpArguments(this.id, Boolean(context.readOnly), policy, typeof node.config.model === 'string' ? node.config.model : undefined), context.repository);
      rpc.onFailure = error => { failure = error; };
      rpc.onMessage = message => {
        interactions = interactions.then(async () => {
          signal.throwIfAborted();
          const params = message.params;
          if (!sessionId || params?.sessionId !== sessionId) { if (message.id !== undefined) rpc!.send({ id: message.id, error: { code: -32602, message: 'Foreign or missing session.' } }); return; }
          if (message.method === 'session/update') {
            const update = params.update;
            if (update?.sessionUpdate === 'agent_message_chunk' && update.content?.type === 'text' && typeof update.content.text === 'string') { text = (text + update.content.text).slice(-32000); await context.output?.(text); }
            if (['tool_call', 'tool_call_update'].includes(update?.sessionUpdate)) await context.activity(`${this.id}: ${String(update.title ?? update.status ?? 'Tool activity').slice(0, 240)}`);
            return;
          }
          if (message.id === undefined) return;
          if (message.method === 'session/request_permission') {
            let allowed = false;
            const tool = params.toolCall; const locations = tool?.locations;
            if (Array.isArray(locations) && locations.length > 0 && locations.length <= 16) {
              try {
                if (tool.kind === 'edit' && !context.readOnly) {
                  await validatePermissions(context.repository, context.frameworkRoot, { fileSystem: { write: locations.map((location: any) => location.path) } });
                  for (const location of locations) await context.validateFileEdit?.(location.path);
                  allowed = await context.approval(`${this.id}: Edit files`, JSON.stringify(tool, null, 2), { kind: 'fileEdit', paths: locations.map((location: any) => location.path), operation: 'unknown' });
                  await validatePermissions(context.repository, context.frameworkRoot, { fileSystem: { write: locations.map((location: any) => location.path) } });
                  for (const location of locations) await context.validateFileEdit?.(location.path);
                } else if (tool.kind === 'read' || tool.kind === 'search') { for (const location of locations) await boundPath(context, location.path); allowed = true; }
              } catch { allowed = false; }
            }
            signal.throwIfAborted(); await context.validate();
            const option = Array.isArray(params.options) && params.options.find((item: any) => item.kind === 'allow_once' && typeof item.optionId === 'string');
            rpc!.send({ id: message.id, result: { outcome: allowed && option ? { outcome: 'selected', optionId: option.optionId } : { outcome: 'cancelled' } } }); return;
          }
          if (message.method === 'fs/read_text_file') {
            const content = await readBound(context, params.path);
            if (params.line !== undefined && (!Number.isInteger(params.line) || params.line < 1) || params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1)) throw new Error('Invalid file line range.');
            rpc!.send({ id: message.id, result: { content: content.split('\n').slice((params.line ?? 1) - 1, params.limit === undefined ? undefined : (params.line ?? 1) - 1 + params.limit).join('\n') } }); return;
          }
          if (message.method === 'fs/write_text_file') {
            if (context.readOnly || typeof params.content !== 'string' || Buffer.byteLength(params.content) > 256000) throw new Error('Read-only or oversized file write rejected.');
            await validateEditPath(context.repository, context.frameworkRoot, params.path); await context.validateFileEdit?.(params.path);
            let original: string | null = null; try { original = await readBound(context, params.path); } catch (error) { if (!missing(error)) throw error; }
            if (!await context.approval(`${this.id}: Save file`, `Path: ${params.path}\n\nCurrent:\n${original ?? '(new file)'}\n\nProposed:\n${params.content}`, { kind: 'fileEdit', paths: [params.path], operation: params.content ? 'update' : 'delete' })) throw new Error('File write declined.');
            signal.throwIfAborted(); await context.validate(); await context.validateFileEdit?.(params.path); await validateEditPath(context.repository, context.frameworkRoot, params.path);
            let current: string | null = null; try { current = await readBound(context, params.path); } catch (error) { if (!missing(error)) throw error; }
            if (current !== original) throw new Error('File changed during approval.');
            const root = inside(context.repository, params.path) ? context.repository : context.frameworkRoot;
            const relative = path.relative(root, params.path).split(path.sep).join('/');
            if (original === null) await createFile(root, relative, params.content);
            else {
              const temporaryFile = relative + '.' + randomUUID() + '.tmp';
              await createFile(root, temporaryFile, params.content);
              try {
                const destination = await safePath(root, relative);
                if (process.platform !== 'win32') await chmod(await safePath(root, temporaryFile), (await stat(destination)).mode);
                await context.validate(); await context.validateFileEdit?.(params.path);
                if (await readBound(context, params.path) !== original) throw new Error('File changed before save.');
                await rename(await safePath(root, temporaryFile), destination);
              } finally { await unlink(await safePath(root, temporaryFile)).catch(error => { if (!missing(error)) throw error; }); }
            }
            rpc!.send({ id: message.id, result: {} }); return;
          }
          rpc!.send({ id: message.id, error: { code: -32601, message: 'Unsupported ACP operation. Shell, network and external tools are disabled.' } });
        }).catch(error => {
          if (message.id !== undefined && !signal.aborted) { try { rpc!.send({ id: message.id, error: { code: -32602, message: String(error).slice(0, 1000) } }); } catch { /* Transport already closed. */ } }
          else if (!signal.aborted) { failure = new Error('ACP event processing failed.'); void rpc?.close().catch(() => {}); }
        });
      };
      const initialized = await rpc.request('initialize', { protocolVersion: 1, clientInfo: { name: 'ai-os-workspace', version: '0.1.26' }, clientCapabilities: { fs: { readTextFile: true, writeTextFile: !context.readOnly }, terminal: false } });
      if (initialized.protocolVersion !== 1) throw new Error('Unsupported ACP version. Update the native CLI.');
      const session = await rpc.request('session/new', { cwd: context.repository, mcpServers: [] });
      if (typeof session.sessionId !== 'string' || !session.sessionId) throw new Error('Provider did not create an ACP session. Sign in using its native CLI first.');
      sessionId = session.sessionId as string; await context.session(sessionId); await context.validate(); signal.throwIfAborted();
      const result = await rpc.request('session/prompt', { sessionId, prompt: [{ type: 'text', text: `AI OS policy context:\n${context.system}\n\n${executionPrompt(node, context)}\n\nConnector capabilities: bound file reads and explicitly approved edits only. Shell, network and external tools are unavailable. Report verification limits honestly.` }] }, 30 * 60 * 1000);
      await interactions; signal.throwIfAborted(); await context.validate();
      if (failure) throw failure;
      if (result.stopReason !== 'end_turn') throw new Error(`Provider stopped without completing the turn: ${String(result.stopReason).slice(0, 80)}`);
      if (!text.trim()) throw new Error('Provider returned no assistant response.');
      return text;
    } finally { signal.removeEventListener('abort', abort); if (rpc) await rpc.close(); if (temporary) { const relative = path.relative(os.tmpdir(), temporary); if (relative.startsWith('aios-gemini-') && !relative.includes(path.sep) && !path.isAbsolute(relative)) await rm(temporary, { recursive: true, force: true }); } }
  }
}
