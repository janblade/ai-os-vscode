import { WorkflowNode } from '../contracts';
import { AgentProvider } from './mock';
import { ExecutionContext, executionPrompt } from './context';
import { RpcProcess, RpcMessage } from './rpc';
import { inlineToml, permissionProfile, validateEditPath, validatePermissions, validateScope } from './boundaries';

export class CodexProvider implements AgentProvider {
  readonly id = 'codex';
  readonly capabilities = { cancellation: true, resume: false, toolApprovals: true };
  constructor(private executable: string, private transport = (command: string, args: string[], cwd: string) => new RpcProcess(command, args, cwd)) {}
  async execute(node: WorkflowNode, signal: AbortSignal, context?: ExecutionContext): Promise<string> {
    if (!context) throw new Error('Codex execution requires a bound context.');
    await context.validate(); await validateScope(context.repository, context.frameworkRoot); signal.throwIfAborted();
    const rpc = this.transport(this.executable, ['app-server', '--stdio', '-c', 'mcp_servers={}', '-c', 'features.hooks=false', '-c', 'default_permissions="ai_os_bound"', '-c', `permissions.ai_os_bound=${inlineToml(permissionProfile(context.frameworkRoot, context.readOnly))}`], context.repository);
    let threadId = ''; let turnId = ''; let output = ''; let finished = false;
    const timeout = setTimeout(() => fail(new Error('Codex turn timed out after 30 minutes. Review existing changes before starting another run.')), 30 * 60 * 1000);
    const messages = new Map<string, string>();
    const publish = async (id: string, text: string) => { messages.set(id, text.slice(-32000)); if (messages.size > 100) messages.delete(messages.keys().next().value!); await context.output?.([...messages.values()].join('\n\n').slice(-32000)); };
    const changes = new Map<string, string[]>();
    const operations = new Map<string, 'update' | 'delete' | 'unknown'>();
    let resolve!: (value: string) => void; let reject!: (error: Error) => void;
    const done = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
    const fail = (error: Error) => { if (!finished) { finished = true; reject(error); } };
    done.catch(() => {});
    rpc.onFailure = fail;
    rpc.onMessage = message => { void receive(message).catch(fail); };
    const receive = async (message: RpcMessage) => {
      const params = message.params ?? {};
      if (params.threadId && params.threadId !== threadId) { if (message.id !== undefined) rpc.send({ id: message.id, error: { message: 'Request belongs to another session.' } }); return; }
      if (finished || params.turnId && turnId && params.turnId !== turnId) return;
      if (message.method === 'item/agentMessage/delta' && params.threadId === threadId && params.turnId === turnId && typeof params.delta === 'string' && typeof params.itemId === 'string') await publish(params.itemId, (messages.get(params.itemId) ?? '') + params.delta);
      if (message.method === 'turn/started') turnId = params.turn?.id ?? turnId;
      if (message.method === 'item/started') {
        const item = params.item;
        if (item?.type === 'fileChange') {
          const patch = item.changes ?? [];
          changes.set(item.id, patch.map((change: any) => change.path));
          operations.set(item.id, patch.some((change: any) => change.kind?.type === 'delete') ? 'delete' : patch.length && patch.every((change: any) => ['add', 'update'].includes(change.kind?.type) && !change.kind.move_path && !change.kind.movePath) ? 'update' : 'unknown');
        }
        if (item) await context!.activity(`Codex: ${({ reasoning: 'Working', agentMessage: 'Writing a response', commandExecution: 'Running a command', fileChange: 'Editing files' } as Record<string, string>)[item.type] ?? item.type}`);
      }
      if (message.method === 'item/completed' && params.item?.type === 'agentMessage') { output = String(params.item.text ?? '').slice(0, 32000); await publish(String(params.item.id ?? 'final'), output); }
      if (message.id !== undefined && message.method) {
        const owned = params.threadId === threadId && Boolean(turnId) && params.turnId === turnId;
        if (!owned) { rpc.send({ id: message.id, error: { message: 'Request does not belong to this run.' } }); return; }
        if (context!.readOnly && message.method.endsWith('/requestApproval')) {
          rpc.send({ id: message.id, result: message.method === 'item/permissions/requestApproval' ? { permissions: {}, scope: 'turn' } : { decision: 'decline' } }); return;
        }
        if (message.method === 'item/commandExecution/requestApproval' || message.method === 'item/fileChange/requestApproval') {
          const editPaths = changes.get(params.itemId)?.slice();
          const editOperation = operations.get(params.itemId);
          if (message.method.includes('fileChange')) {
            const paths = editPaths;
            if (!paths?.length) { rpc.send({ id: message.id, result: { decision: 'decline' } }); return; }
            try { for (const file of paths) await validateEditPath(context!.repository, context!.frameworkRoot, file); }
            catch { rpc.send({ id: message.id, result: { decision: 'decline' } }); return; }
          }
          try { await validatePermissions(context!.repository, context!.frameworkRoot, params.additionalPermissions); }
          catch { rpc.send({ id: message.id, result: { decision: 'decline' } }); return; }
          const details = JSON.stringify({ additionalPermissions: params.additionalPermissions, networkApprovalContext: params.networkApprovalContext, command: params.command, cwd: params.cwd, reason: params.reason, paths: changes.get(params.itemId) }, null, 2);
          const scopedEdit = message.method.includes('fileChange') && !params.additionalPermissions && !params.networkApprovalContext && !params.command;
          const allow = await context!.approval('Codex tool approval', details, scopedEdit ? { kind: 'fileEdit', paths: editPaths!, operation: editOperation ?? 'unknown' } : undefined);
          signal.throwIfAborted(); await context!.validate();
          if (allow && message.method.includes('fileChange')) {
            if (JSON.stringify(changes.get(params.itemId)) !== JSON.stringify(editPaths) || operations.get(params.itemId) !== editOperation) { rpc.send({ id: message.id, result: { decision: 'decline' } }); return; }
            for (const file of editPaths!) await validateEditPath(context!.repository, context!.frameworkRoot, file);
          }
          // Approvals never create persistent rules or grant a whole session.
          rpc.send({ id: message.id, result: { decision: allow ? 'accept' : 'decline' } }); return;
        }
        if (message.method === 'item/permissions/requestApproval') {
          let allow = false;
          try {
            await validatePermissions(context!.repository, context!.frameworkRoot, params.permissions);
            allow = await context!.approval('Codex additional permissions (this turn only)', JSON.stringify({ permissions: params.permissions, reason: params.reason }, null, 2));
            signal.throwIfAborted(); await context!.validate();
            if (allow) await validatePermissions(context!.repository, context!.frameworkRoot, params.permissions);
          } catch { allow = false; }
          rpc.send({ id: message.id, result: { permissions: allow ? params.permissions : {}, scope: 'turn' } }); return;
        }
        if (message.method === 'item/tool/requestUserInput') {
          const answers: Record<string, { answers: string[] }> = {};
          for (const question of params.questions ?? []) {
            const answer = await context!.input(question);
            signal.throwIfAborted(); await context!.validate();
            answers[question.id] = { answers: answer === null ? [] : [answer] };
          }
          rpc.send({ id: message.id, result: { answers } }); return;
        }
        rpc.send({ id: message.id, error: { message: 'This host does not support that interactive request.' } }); return;
      }
      if (message.method === 'thread/tokenUsage/updated' && params.threadId === threadId && params.turnId === turnId) {
        const usage = params.tokenUsage?.total;
        if (usage) await context!.usage?.({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, ...(usage.cachedInputTokens !== undefined ? {cachedInputTokens:usage.cachedInputTokens} : {}) });
      }
      if (message.method === 'turn/completed') {
        if (turnId && params.turn?.id !== turnId) return;
        const status = params.turn?.status;
        if (status !== 'completed') { fail(new Error(`Codex turn ${status ?? 'failed'}: ${params.turn?.error?.message ?? ''}`)); return; }
        finished = true; resolve(output);
      }
    };
    const abort = () => {
      if (threadId && turnId) void rpc.request('turn/interrupt', { threadId, turnId }, 2000).catch(() => {}).finally(() => rpc.close()).catch(() => {});
      else void rpc.close().catch(() => {});
      fail(new Error('Codex execution cancelled.'));
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'ai_os_workspace', version: '0.1.10' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} });
      const profiles = await rpc.request('permissionProfile/list', { cwd: context.repository });
      if (!profiles.data?.some((profile: any) => profile.id === 'ai_os_bound' && profile.allowed)) throw new Error('Codex does not permit the required bound permission profile.');
      const start = await rpc.request('thread/start', { cwd: context.repository, permissions: 'ai_os_bound', approvalPolicy: context.readOnly ? 'never' : 'on-request', ...(context.readOnly ? { ephemeral: true } : {}), approvalsReviewer: 'user',
        developerInstructions: context.system, ...(typeof node.config.model === 'string' ? { model: node.config.model } : {}) });
      threadId = start.thread.id;
      if (start.activePermissionProfile?.id !== 'ai_os_bound') throw new Error('Codex did not apply the bound permission profile.');
      if (context.readOnly && start.sandbox?.type !== 'readOnly') throw new Error('Codex did not apply read-only task drafting.');
      await context.session(threadId); await context.validate(); signal.throwIfAborted();
      const turn = await rpc.request('turn/start', { threadId, input: [{ type: 'text', text: executionPrompt(node, context) }] });
      turnId = turn.turn.id;
      return await done;
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); await rpc.close(); }
  }
}
