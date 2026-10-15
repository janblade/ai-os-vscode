import { inside } from '../framework/workspace';
import { AcpProvider } from './acp';
import * as vscode from 'vscode';
import path from 'node:path';
import { stat, realpath, readFile } from 'node:fs/promises';
import { AgentProvider, MockProvider } from './mock';
import { CodexProvider } from './codex';
import { ClaudeProvider } from './claude';
import { ExecutionContext } from './context';
import { WorkflowNode, NativeProviderId } from '../contracts';

async function executable(name: NativeProviderId, repository: string): Promise<string> {
  const configured = vscode.workspace.getConfiguration('aiOs').get<string>(`${name}Path`);
  const filename = process.platform === 'win32' ? `${name}.exe` : name;
  const bundled = name === 'codex' && vscode.extensions.getExtension('openai.chatgpt');
  const candidates = configured ? [configured] : [
    ...(bundled ? [path.join(bundled.extensionPath, 'bin', process.platform === 'win32' ? `windows-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}` : `${process.platform}-${process.arch}`, filename)] : []),
    ...String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory)).map(directory => path.join(directory, filename)),
  ];
  if (!configured && (name === 'gemini' || name === 'copilot')) {
    const packageName = name === 'gemini' ? '@google/gemini-cli' : '@github/copilot';
    for (const directory of String(process.env.PATH ?? '').split(path.delimiter).filter(directory => path.isAbsolute(directory))) {
      try {
        const packageFile = path.join(directory, 'node_modules', packageName, 'package.json');
        const metadata = JSON.parse(await readFile(packageFile, 'utf8'));
        const bin = typeof metadata.bin === 'string' ? metadata.bin : metadata.bin?.[name];
        if (typeof bin === 'string') candidates.push(path.resolve(path.dirname(packageFile), bin));
      } catch { /* Native executable discovery remains available. */ }
    }
  }
  for (const candidate of candidates) {
    if (!path.isAbsolute(candidate)) continue;
    try {
      const file = await realpath(candidate);
      if (inside(repository, file)) continue;
      if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(file)) continue;
      if ((await stat(file)).isFile()) return file;
    } catch { /* Try the next native installation. */ }
  }
  throw new Error(`Install and sign in to native ${name}, or set aiOs.${name}Path to its absolute executable path outside the repository.`);
}
export class ProviderRouter implements AgentProvider {
  readonly id = 'native-router';
  readonly capabilities = { cancellation: true, resume: false, toolApprovals: true };
  constructor(private worker: string) {}
  async execute(node: WorkflowNode, signal: AbortSignal, context?: ExecutionContext): Promise<string> {
    if (node.config.provider === 'mock') return new MockProvider().execute(node, signal);
    if (!context) throw new Error('Native providers require a bound task context.');
    const name = node.config.provider;
    if (!['codex', 'claude', 'gemini', 'copilot'].includes(String(name))) throw new Error('Unsupported provider.');
    const cli = await executable(name as NativeProviderId, context.repository);
    const provider = name === 'codex' ? new CodexProvider(cli) : name === 'claude' ? new ClaudeProvider(cli, this.worker) : new AcpProvider(name as 'gemini' | 'copilot', cli);
    return provider.execute(node, signal, context);
  }
}
