import { WorkflowNode } from '../contracts';
import { AgentProvider } from './mock';
import { ExecutionContext, executionPrompt } from './context';
import { validateScope } from './boundaries';
import { RpcProcess } from './rpc';
export class ClaudeProvider implements AgentProvider {
  readonly id = 'claude';
  readonly capabilities = { cancellation: true, resume: false, toolApprovals: true };
  constructor(private executable: string, private worker: string, private transport = (worker: string, cwd: string) => new RpcProcess(process.execPath, [worker], cwd, { ...process.env, ELECTRON_RUN_AS_NODE: '1' })) {}
  async execute(node: WorkflowNode, signal: AbortSignal, context?: ExecutionContext): Promise<string> {
    if (!context) throw new Error('Claude execution requires a bound context.');
    await context.validate(); await validateScope(context.repository, context.frameworkRoot); signal.throwIfAborted();
    const rpc = this.transport(this.worker, context.repository);
    let liveText = '';
    rpc.onMessage = message => {
      void (async () => {
        if (message.method === 'session') await context.session(String(message.params.id));
        if (message.method === 'output' || message.method === 'output/delta') { liveText = (message.method === 'output' ? String(message.params.text) : liveText + String(message.params.text)).slice(-32000); await context.output?.(liveText); }
        if (message.method === 'usage') await context.usage?.(message.params as any);
        if (message.method === 'activity') await context.activity(String(message.params.summary));
        if (message.method === 'tool/approval' && message.id !== undefined) {
          const allow = !context.readOnly && await context.approval(String(message.params.summary), String(message.params.details), message.params.request);
          signal.throwIfAborted(); await context.validate(); rpc.send({ id: message.id, result: allow });
        }
        if (message.method === 'tool/input' && message.id !== undefined) {
          const answer = await context.input(message.params.question); signal.throwIfAborted(); await context.validate(); rpc.send({ id: message.id, result: answer });
        }
      })().catch(() => rpc.close()).catch(() => {});
    };
    const abort = () => { void rpc.close().catch(() => {}); }; signal.addEventListener('abort', abort, { once: true });
    try { return await rpc.request('run/start', { cwd: context.repository, frameworkRoot: context.frameworkRoot, cli: this.executable,
      prompt: executionPrompt(node, context), system: context.system, model: node.config.model, readOnly: context.readOnly, discovery: node.config.readOnly === true }, 30 * 60 * 1000); }
    finally { signal.removeEventListener('abort', abort); await rpc.close(); }
  }
}
