import { setTimeout } from 'node:timers/promises';
import { ExecutionContext } from './context';
import { WorkflowNode } from '../contracts';

export interface AgentProvider {
  readonly id: string;
  readonly capabilities: { cancellation: boolean; resume: boolean; toolApprovals: boolean };
  execute(node: WorkflowNode, signal: AbortSignal, context?: ExecutionContext): Promise<string>;
}

export class MockProvider implements AgentProvider {
  readonly id = 'mock';
  readonly capabilities = { cancellation: true, resume: false, toolApprovals: false };
  async execute(node: WorkflowNode, signal: AbortSignal): Promise<string> {
    await setTimeout(500, undefined, { signal });
    return `Mock completed: ${node.label}. No model was contacted and no project files were changed.\nPrompt: ${node.config.prompt}`;
  }
}
