import { query, HookCallback } from '@anthropic-ai/claude-agent-sdk';
import { createInterface } from 'node:readline';
import { validateEditPath, kernelPaths, userPaths, memoryPaths, claudeTools } from './boundaries.js';
const controller = new AbortController();
const pending = new Map<string, (value: any) => void>();
let next = 1; let started = false;
const send = (message: object) => process.stdout.write(JSON.stringify(message) + '\n');
function request(method: string, params: object): Promise<any> {
  const id = `claude-${next++}`;
  return new Promise(resolve => { pending.set(id, resolve); send({ id, method, params }); });
}
async function run(id: number, params: any): Promise<void> {
  const gate: HookCallback = async input => {
    if (input.hook_event_name !== 'PreToolUse') return {};
    if (!claudeTools(process.platform, params.readOnly, params.discovery).includes(input.tool_name)) return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'This tool is outside the connector gate. On Windows use Codex for sandboxed shell execution.' } };
    const tool = input.tool_name; const args = input.tool_input as Record<string, unknown>;
    if (['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
      try { await validateEditPath(params.cwd, params.frameworkRoot, args.file_path ?? args.notebook_path); }
      catch { return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Protected or out-of-scope path. Use the existing human authorization flow.' } }; }
      return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask' } };
    }
    return {};
  };
  const agent = query({ prompt: params.prompt, options: {
    cwd: params.cwd, pathToClaudeCodeExecutable: params.cli, abortController: controller,
    systemPrompt: { type: 'preset', preset: 'claude_code', append: params.system },
    includePartialMessages: true, settingSources: [], tools: claudeTools(process.platform, params.readOnly, params.discovery), mcpServers: {},
    ...(params.readOnly ? { persistSession: false } : {}), permissionMode: 'default',
    ...(params.model ? { model: params.model } : {}),
    hooks: { PreToolUse: [{ hooks: [gate] }] },
    sandbox: { enabled: process.platform !== 'win32', allowUnsandboxedCommands: false,
      filesystem: { allowWrite: params.readOnly ? [] : userPaths(params.frameworkRoot), denyWrite: [...kernelPaths(params.cwd), ...kernelPaths(params.frameworkRoot), ...memoryPaths(params.cwd), ...memoryPaths(params.frameworkRoot), ...[params.cwd, params.frameworkRoot].flatMap(directory => ['.git', '.codex', '.claude', '.gemini', '.copilot'].map(name => directory + '/' + name))] } },
    canUseTool: async (tool, input) => {
      if (!claudeTools(process.platform, params.readOnly, params.discovery).includes(tool)) return { behavior: 'deny', message: 'Tool is outside the connector gate. Use Codex for Windows shell execution.' };
      if (tool === 'AskUserQuestion') {
        const answers: Record<string, string> = {};
        for (const question of (input.questions as any[]) ?? []) {
          const answer = await request('tool/input', { question });
          if (typeof answer !== 'string') return { behavior: 'deny', message: 'Question cancelled.' };
          answers[question.question] = answer;
        }
        return { behavior: 'allow', updatedInput: { ...input, answers } };
      }
      if (params.readOnly) return { behavior: 'allow', updatedInput: input };
      const allowed = await request('tool/approval', { summary: `Claude: ${tool}`, details: JSON.stringify(input, null, 2), ...(['Write', 'Edit', 'NotebookEdit'].includes(tool) ? { request: { kind: 'fileEdit', paths: [input.file_path ?? input.notebook_path], operation: tool === 'NotebookEdit' && input.edit_mode === 'delete' || tool === 'Write' && !input.content ? 'delete' : 'update' } } : {}) });
      if (allowed && ['Write', 'Edit', 'NotebookEdit'].includes(tool)) {
        try { await validateEditPath(params.cwd, params.frameworkRoot, input.file_path ?? input.notebook_path); }
        catch { return { behavior: 'deny', message: 'Path changed or is protected.' }; }
      }
      return allowed ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: 'Declined by the user.' };
    }, stderr: () => {},
  } });
  let result: string | undefined; let transcript = ''; let partial = '';

  try {
    for await (const message of agent) {
      if (controller.signal.aborted) break;
      if (message.type === 'system' && message.subtype === 'init') send({ method: 'session', params: { id: message.session_id } });
      if (message.type === 'stream_event') {
        if (message.event.type === 'message_start') partial = '';
        if (message.event.type === 'content_block_delta' && message.event.delta.type === 'text_delta') {
          const text = (partial ? '' : transcript ? '\n\n' : '') + message.event.delta.text; partial = (partial + text).slice(-32000);
          send({ method: 'output/delta', params: { text } });
        }
      }
      if (message.type === 'assistant') {
        const text = message.message.content.filter(content => content.type === 'text').map(content => content.text).join('\n');
        if (text) { transcript = (transcript + (transcript ? '\n\n' : '') + text).slice(-32000); partial = ''; send({ method: 'output', params: { text: transcript } }); }
        for (const content of message.message.content) if (content.type === 'tool_use') send({ method: 'activity', params: { summary: `Claude: ${content.name}` } });
      }
      if (message.type === 'result') {
        if (message.subtype !== 'success' || message.is_error) throw new Error(`Claude returned ${message.subtype}. Check the native Claude client for details.`);
        if (message.usage) send({method:'usage',params:{inputTokens:message.usage.input_tokens,outputTokens:message.usage.output_tokens,cachedInputTokens:message.usage.cache_read_input_tokens}});
        result = message.result.slice(0, 32000);
      }
    }
    if (controller.signal.aborted) throw new Error('Claude execution cancelled.');
    if (result === undefined) throw new Error('Claude ended without a result.');
    send({ id, result });
  } catch (error) { send({ id, error: { message: String(error).slice(0, 1000) } }); }
}
createInterface({ input: process.stdin, crlfDelay: Infinity }).on('line', line => {
  try {
    if (line.length > 2 * 1024 * 1024) throw new Error('Request too large.');
    const message = JSON.parse(line);
    if (message.method === 'run/health') {
      if (!message.params?.cli) send({ id: message.id, result: { ready: true } });
      else void (async () => {
        const health = query({ prompt: (async function* () {})(), options: { cwd: message.params.cwd, pathToClaudeCodeExecutable: message.params.cli, settingSources: [], tools: [], persistSession: false, stderr: () => {} } });
        try { await health.initializationResult(); send({ id: message.id, result: { ready: true, nativeInitialized: true } }); }
        catch { send({ id: message.id, error: { message: 'Native Claude SDK initialization failed.' } }); }
        finally { health.close(); }
      })();
    }
    else if (message.method === 'run/start' && !started) { started = true; void run(message.id, message.params); }
    else if (pending.has(message.id)) { pending.get(message.id)!(message.result); pending.delete(message.id); }
  } catch { controller.abort(); }
}).on('close', () => { controller.abort(); for (const resolve of pending.values()) resolve(false); });
process.on('SIGTERM', () => { controller.abort(); for (const resolve of pending.values()) resolve(false); });
