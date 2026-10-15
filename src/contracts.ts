export function validAgentId(value: unknown): value is string { return typeof value === 'string' && value.length <= 100 && /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) && !['__proto__', 'constructor', 'prototype'].includes(value); }
export const providers = ['mock', 'codex', 'claude', 'gemini', 'copilot'] as const;
export type ProviderId = typeof providers[number];
export type NativeProviderId = Exclude<ProviderId, 'mock'>;
export const providerLabels: Record<ProviderId, string> = { mock: 'Mock (local test)', codex: 'Codex', claude: 'Claude Code', gemini: 'Gemini CLI', copilot: 'GitHub Copilot CLI' };
export type NodeKind = 'agent' | 'approval';
export interface WorkflowNode {
  id: string; kind: NodeKind; label: string;
  position: { x: number; y: number; [key: string]: unknown };
  config: Record<string, unknown>;
  [key: string]: unknown;
}
export interface WorkflowEdge {
  id: string; source: string; target: string; sourcePort: 'success'; targetPort: 'in';
  [key: string]: unknown;
}
export interface Workflow {
  version: 1; id: string; name: string; nodes: WorkflowNode[]; edges: WorkflowEdge[];
  [key: string]: unknown;
}
export type Change =
  | { kind: 'rename'; name: string }
  | { kind: 'move'; nodeId: string; x: number; y: number }
  | { kind: 'configure'; nodeId: string; label: string; prompt: string; agentId?: string | null; provider?: ProviderId; model?: string; optional?: boolean }
  | { kind: 'append'; nodeKind: NodeKind }
  | { kind: 'remove'; nodeId: string };
export type ClientMessage =
  | { type: 'ready' }
  | { type: 'openText' }
  | { type: 'update'; revision: number; change: Change }
  | { type: 'run'; revision: number }
  | { type: 'cancel'; runId: string }
  | { type: 'approve'; runId: string };
export type RunStatus = 'queued' | 'running' | 'waitingApproval' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export interface ProviderUsage { inputTokens: number; outputTokens: number; cachedInputTokens?: number }
export interface PhaseContext { bytes: number; estimatedTokens: number; sources: {source: string; sha256: string}[] }
export interface StepState { skipReason?: string; previousOutput?: string; context?: PhaseContext; usage?: ProviderUsage; memoryApproval?: string[]; liveOutput?: string; lastActivityAt?: string; events?: { at: string; summary: string }[]; status: RunStatus; output?: string; startedAt?: string; finishedAt?: string; activity?: string; providerSessionId?: string; toolApproval?: boolean }
export interface RunReview { acceptedAt: string; repositoryToken: string; verification: string; findings: string }
export interface StoryLink { epicId?: string; epicUri: string; id: string; title: string; sha256: string }
export interface Run {
  version: 1; id: string; workflow: Workflow; workflowUri: string; repositoryUri: string;
  finalization?: { fromRunId: string; command: 'WRAP' | 'TASK_CLOSE'; reason: string };
  guidance?: { nodeId: string; report: string; answer: string }[];
  review?: RunReview; taskUri?: string; taskId?: string; story?: StoryLink; status: RunStatus; createdAt: string; updatedAt: string;
  recovery?: { fromRunId: string; fromNodeId: string; mode: 'fresh' | 'retry' };
  steps: Record<string, StepState>; error?: string;
}
export type HostMessage =
  | { type: 'document'; revision: number; workflow?: Workflow; error?: string; trusted: boolean; agents?: { id: string; name: string; provider?: ProviderId }[] }
  | { type: 'run'; run: Run }
  | { type: 'error'; message: string };

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object.');
  return value as Record<string, unknown>;
}
function string(value: unknown, max = 200): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Expected text (1–${max} characters).`);
}
function id(value: unknown): asserts value is string {
  string(value, 100);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/.test(value) || ['__proto__', 'constructor', 'prototype'].includes(value)) throw new Error('Invalid identifier.');
}
function coordinate(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100000) throw new Error('Invalid node position.');
}
function exact(value: Record<string, unknown>, keys: string[]) {
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('Unexpected message field.');
}
export function parseMessage(input: unknown): ClientMessage {
  const value = object(input);
  switch (value.type) {
    case 'ready': case 'openText': exact(value, ['type']); break;
    case 'cancel': case 'approve': exact(value, ['type', 'runId']); id(value.runId); break;
    case 'run': case 'update': {
      exact(value, value.type === 'run' ? ['type', 'revision'] : ['type', 'revision', 'change']);
      if (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1) throw new Error('Invalid document revision.');
      if (value.type === 'run') break;
      const change = object(value.change);
      switch (change.kind) {
        case 'rename': exact(change, ['kind', 'name']); string(change.name); break;
        case 'move': exact(change, ['kind', 'nodeId', 'x', 'y']); id(change.nodeId); coordinate(change.x); coordinate(change.y); break;
        case 'configure':
          exact(change, ['kind', 'nodeId', 'label', 'prompt', 'agentId', 'provider', 'model', 'optional']); id(change.nodeId); string(change.label);
          if (typeof change.prompt !== 'string' || change.prompt.length > 16000) throw new Error('Prompt is too long.');
          if (change.agentId !== undefined && change.agentId !== null && change.agentId !== '' && !validAgentId(change.agentId)) throw new Error('Invalid agent ID.');
          if (change.optional !== undefined && typeof change.optional !== 'boolean') throw new Error('Invalid optional phase flag.');
          if (change.provider !== undefined && !providers.includes(change.provider as ProviderId)) throw new Error('Unsupported provider.');
          if (change.model !== undefined && (typeof change.model !== 'string' || change.model.length > 200 || /[\r\n]/.test(change.model))) throw new Error('Invalid model.');
          break;
        case 'append': exact(change, ['kind', 'nodeKind']); if (!['agent', 'approval'].includes(change.nodeKind as string)) throw new Error('Unsupported node.'); break;
        case 'remove': exact(change, ['kind', 'nodeId']); id(change.nodeId); break;
        default: throw new Error('Unsupported edit.');
      }
      break;
    }
    default: throw new Error('Unsupported message.');
  }
  return value as unknown as ClientMessage;
}

export function parseWorkflow(text: string): Workflow {
  if (text.length > 256000) throw new Error('Workflow exceeds 256 KB. Open as text.');
  const value = object(JSON.parse(text));
  if (value.version !== 1) throw new Error('Unsupported workflow version. Open as text; original content is preserved.');
  id(value.id); string(value.name);
  if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 50 || !Array.isArray(value.edges)) throw new Error('Expected 1–50 nodes and an edges array.');
  for (const item of value.nodes) {
    const node = object(item); id(node.id); string(node.label);
    const position = object(node.position); coordinate(position.x); coordinate(position.y);
    const config = object(node.config);
    if (node.kind === 'agent') {
      for (const flag of ['readOnly', 'requireVerification', 'optional']) if (config[flag] !== undefined && typeof config[flag] !== 'boolean') throw new Error('Invalid step execution gate.');
      if (!providers.includes(config.provider as ProviderId)) throw new Error('Unsupported provider.');
      if (config.model !== undefined) string(config.model, 200);
      string(config.prompt, 16000);
      if (config.agentId !== undefined && config.agentId !== null && !validAgentId(config.agentId)) throw new Error('Invalid agent ID.');
    } else if (node.kind !== 'approval') throw new Error('Unsupported node type. Open as text.');
  }
  for (const item of value.edges) {
    const edge = object(item); id(edge.id); id(edge.source); id(edge.target);
    if (edge.sourcePort !== 'success' || edge.targetPort !== 'in') throw new Error('Unsupported edge port.');
  }
  const workflow = value as unknown as Workflow;
  orderedNodes(workflow);
  return workflow;
}

export function orderedNodes(workflow: Workflow): WorkflowNode[] {
  const nodes = new Map(workflow.nodes.map(node => [node.id, node]));
  const next = new Map<string, string>(); const incoming = new Set<string>(); const edgeIds = new Set<string>();
  if (!nodes.size || nodes.size !== workflow.nodes.length) throw new Error('Empty or duplicate nodes.');
  for (const edge of workflow.edges) {
    if (!nodes.has(edge.source) || !nodes.has(edge.target) || next.has(edge.source) || incoming.has(edge.target) || edgeIds.has(edge.id)) throw new Error('Only one connected linear workflow is supported.');
    next.set(edge.source, edge.target); incoming.add(edge.target); edgeIds.add(edge.id);
  }
  const starts = workflow.nodes.filter(node => !incoming.has(node.id));
  if (starts.length !== 1) throw new Error('Workflow must have exactly one start.');
  const ordered: WorkflowNode[] = []; const seen = new Set<string>();
  let cursor: string | undefined = starts[0].id;
  while (cursor) {
    if (seen.has(cursor)) throw new Error('Cycles are not supported.');
    seen.add(cursor); ordered.push(nodes.get(cursor)!); cursor = next.get(cursor);
  }
  if (ordered.length !== nodes.size) throw new Error('Workflow contains unreachable nodes or cycles.');
  return ordered;
}

export function applyChange(original: Workflow, change: Change, newId = ''): Workflow {
  const workflow = structuredClone(original);
  if (change.kind === 'rename') workflow.name = change.name;
  else if (change.kind === 'append') {
    id(newId);
    const last = orderedNodes(workflow).at(-1)!;
    workflow.nodes.push({ id: newId, kind: change.nodeKind, label: change.nodeKind === 'agent' ? 'Mock agent' : 'Human approval', position: { x: last.position.x + 280, y: last.position.y }, config: change.nodeKind === 'agent' ? { provider: 'mock', prompt: 'Summarize this task.' } : {} });
    workflow.edges.push({ id: `edge-${newId}`, source: last.id, target: newId, sourcePort: 'success', targetPort: 'in' });
  } else {
    const node = workflow.nodes.find(item => item.id === change.nodeId);
    if (!node) throw new Error('Node no longer exists.');
    if (change.kind === 'move') node.position = { ...node.position, x: change.x, y: change.y };
    if (change.kind === 'configure') {
      node.label = change.label;
      if (node.kind === 'agent') {
        node.config = { ...node.config, prompt: change.prompt };
        if (change.provider !== undefined) node.config.provider = change.provider;
        if (change.model === '') delete node.config.model;
        else if (change.model !== undefined) node.config.model = change.model;
        if (change.optional !== undefined) node.config.optional = change.optional;
        if (change.agentId === '') delete node.config.agentId;
        else if (change.agentId !== undefined) node.config.agentId = change.agentId;
      }
    }
    if (change.kind === 'remove') {
      if (workflow.nodes.length === 1) throw new Error('Keep at least one node.');
      const incoming = workflow.edges.find(edge => edge.target === node.id);
      const outgoing = workflow.edges.find(edge => edge.source === node.id);
      workflow.nodes = workflow.nodes.filter(item => item.id !== node.id);
      workflow.edges = workflow.edges.filter(edge => edge.source !== node.id && edge.target !== node.id);
      if (incoming && outgoing) workflow.edges.push({ ...incoming, target: outgoing.target });
    }
  }
  return parseWorkflow(JSON.stringify(workflow));
}

export function exampleWorkflow(workflowId: string): Workflow {
  return { version: 1, id: workflowId, name: 'Plan and review', nodes: [
    { id: 'plan', kind: 'agent', label: 'Draft a plan', position: { x: 80, y: 100 }, config: { provider: 'mock', prompt: 'Draft a short implementation plan for the selected task.' } },
    { id: 'review', kind: 'approval', label: 'Review the result', position: { x: 380, y: 100 }, config: {} },
  ], edges: [{ id: 'plan-review', source: 'plan', target: 'review', sourcePort: 'success', targetPort: 'in' }] };
}
