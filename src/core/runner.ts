import { skippable } from './run-finish';
import { ContextChangedError } from './context-memory';
import { parseVerificationReport } from './verification';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, unlink } from 'node:fs/promises';
import { Run, Workflow, orderedNodes, parseWorkflow, object } from '../contracts';
import { atomicJson, listFiles, readText } from './files';
import path from 'node:path';
import { preparedContext, validPhaseContext, validUsage } from './run-insights';
import { ExecutionContext, executionPrompt } from '../providers/context';
import { AgentProvider } from '../providers/mock';

const now = () => new Date().toISOString();
export class RunStore {
  readonly problems: string[] = [];
  constructor(readonly root: string) {}
  async save(run: Run): Promise<void> {
    await mkdir(this.root, { recursive: true });
    await atomicJson(this.root, `snapshots/${run.id}.json`, run);
  }
  async list(): Promise<Run[]> {
    await mkdir(this.root, { recursive: true });
    const files = await listFiles(this.root, 'snapshots');
    this.problems.length = 0;
    const runs: Run[] = [];
    for (const file of files.filter(file => file.endsWith('.json'))) {
      try {
        const run = parseRun(await readText(this.root, file, 1000000));
        if (file !== `snapshots/${run.id}.json`) throw new Error('Snapshot ID does not match its filename.');
        runs.push(run);
      } catch (error) { this.problems.push(`${file}: ${String(error)}`); }
    }
    return runs;
  }
  async recover(): Promise<Run[]> {
    const runs = await this.list();
    for (const run of runs) {
      if (run.status === 'running' || run.status === 'queued' || (run.status === 'waitingApproval' && (run.story || run.workflow.nodes.some(node => node.kind === 'agent' && node.config.provider !== 'mock')))) {
        run.status = 'interrupted'; run.updatedAt = now();
        for (const step of Object.values(run.steps)) if (step.status === 'running' || step.status === 'waitingApproval') step.status = 'interrupted';
        await this.save(run);
      }
    }
    return runs;
  }
}

export function parseRun(text: string): Run {
  const value = object(JSON.parse(text));
  if (value.version !== 1 || typeof value.id !== 'string' || !/^[a-f0-9-]{36}$/.test(value.id) || typeof value.workflowUri !== 'string' || typeof value.repositoryUri !== 'string' || typeof value.createdAt !== 'string' || typeof value.updatedAt !== 'string' || !['queued', 'running', 'waitingApproval', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status as string)) throw new Error('Invalid run snapshot.');
  const workflow = parseWorkflow(JSON.stringify(value.workflow)); const steps = object(value.steps);
  if ((value.error !== undefined && typeof value.error !== 'string') || (value.taskUri !== undefined && typeof value.taskUri !== 'string') || (value.taskId !== undefined && (typeof value.taskId !== 'string' || !/^[a-f0-9-]{36}$/.test(value.taskId)))) throw new Error('Invalid run metadata.');
  if (value.story !== undefined) {
    const story = object(value.story);
    if (Object.keys(story).some(key => !['epicUri', 'epicId', 'id', 'sha256', 'title'].includes(key)) || (story.epicId !== undefined && (typeof story.epicId !== 'string' || !/^[a-f0-9-]{36}$/.test(story.epicId))) || typeof story.epicUri !== 'string' || !story.epicUri.startsWith('file:') || typeof story.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(story.id) || typeof story.title !== 'string' || !story.title || story.title.length > 1000 || typeof story.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(story.sha256)) throw new Error('Invalid run story link.');
  }
  if (Object.keys(steps).length !== workflow.nodes.length) throw new Error('Invalid run steps.');
  for (const node of workflow.nodes) {
    const step = object(steps[node.id]);
    if (!['queued', 'running', 'waitingApproval', 'succeeded', 'failed', 'cancelled', 'interrupted'].includes(step.status as string)) throw new Error('Invalid step status.');
    for (const field of ['activity', 'providerSessionId']) if (step[field] !== undefined && (typeof step[field] !== 'string' || (step[field] as string).length > 300)) throw new Error('Invalid provider metadata.');
    if (step.context !== undefined && !validPhaseContext(step.context) || step.usage !== undefined && !validUsage(step.usage)) throw new Error('Invalid run insights.');
    if (step.memoryApproval !== undefined && (!Array.isArray(step.memoryApproval) || !step.memoryApproval.length || step.memoryApproval.length > 16 || step.memoryApproval.some(file => typeof file !== 'string' || !/^\.ai-os\/memory\/proposals\/[^/\\:\x00-\x1f]+\.json$/.test(file)))) throw new Error('Invalid memory approval request.');
    if (step.toolApproval !== undefined && typeof step.toolApproval !== 'boolean') throw new Error('Invalid tool approval.');
    if (step.liveOutput !== undefined && (typeof step.liveOutput !== 'string' || step.liveOutput.length > 32000)) throw new Error('Invalid live output.');
    if (step.lastActivityAt !== undefined && (typeof step.lastActivityAt !== 'string' || !Number.isFinite(Date.parse(step.lastActivityAt)))) throw new Error('Invalid activity timestamp.');
    if (step.events !== undefined && (!Array.isArray(step.events) || step.events.length > 30 || step.events.some(event => !event || typeof event.summary !== 'string' || event.summary.length > 300 || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))))) throw new Error('Invalid activity trail.');
    if (step.previousOutput !== undefined && (typeof step.previousOutput !== 'string' || step.previousOutput.length > 32000)) throw new Error('Invalid previous phase output.');
    if (step.skipReason !== undefined && (typeof step.skipReason !== 'string' || !step.skipReason.trim() || step.skipReason.length > 16000 || step.status !== 'cancelled' || !skippable(node))) throw new Error('Invalid skipped phase.');
    if (step.output !== undefined && typeof step.output !== 'string') throw new Error('Invalid step output.');
  }
  if (value.guidance !== undefined && (!Array.isArray(value.guidance) || value.guidance.length > 32 || value.guidance.some(entry => !entry || typeof entry !== 'object' || Array.isArray(entry) || typeof entry.nodeId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(entry.nodeId) || typeof entry.report !== 'string' || entry.report.length > 32000 || typeof entry.answer !== 'string' || !entry.answer.trim() || entry.answer.length > 16000))) throw new Error('Invalid run guidance.');
  if (value.finalization !== undefined) {
    const finish = object(value.finalization);
    if (Object.keys(finish).length !== 3 || typeof finish.fromRunId !== 'string' || !/^[a-f0-9-]{36}$/.test(finish.fromRunId) || !['WRAP', 'TASK_CLOSE'].includes(String(finish.command)) || typeof finish.reason !== 'string' || !finish.reason.trim() || finish.reason.length > 16000) throw new Error('Invalid finalization metadata.');
  }
  if (value.recovery !== undefined) {
    const recovery = object(value.recovery);
    if (Object.keys(recovery).some(key => !['fromRunId', 'fromNodeId', 'mode'].includes(key)) || typeof recovery.fromRunId !== 'string' || !/^[a-f0-9-]{36}$/.test(recovery.fromRunId) || typeof recovery.fromNodeId !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(recovery.fromNodeId) || !['fresh', 'retry'].includes(String(recovery.mode))) throw new Error('Invalid recovery metadata.');
  }
  if (value.review !== undefined) {
    const review = object(value.review);
    if (typeof review.acceptedAt !== 'string' || !Number.isFinite(Date.parse(review.acceptedAt)) || typeof review.repositoryToken !== 'string' || !/^[a-f0-9]{64}$/.test(review.repositoryToken) || typeof review.verification !== 'string' || !review.verification.trim() || review.verification.length > 16000 || typeof review.findings !== 'string' || !review.findings.trim() || review.findings.length > 16000 || !['succeeded', 'failed', 'cancelled', 'interrupted'].includes(value.status as string)) throw new Error('Invalid human review receipt.');
  }
  return value as unknown as Run;
}

export class Runner {
  private active = new Map<string, { run: Run; controller: AbortController; approve?: () => void; resumeMemory?: () => void; done: Promise<void>; context?: Omit<ExecutionContext, 'runId'> }>();
  constructor(private store: RunStore, private provider: AgentProvider, private changed: (run: Run) => void, private failed: (error: unknown) => void, private lockRoot = path.join(store.root, 'locks')) {}
  private writes = Promise.resolve();
  private async persist(run: Run) {
    run.updatedAt = now();
    const snapshot = structuredClone(run);
    const write = this.writes.then(async () => { await this.store.save(snapshot); this.changed(snapshot); });
    this.writes = write.catch(() => {});
    await write;
  }
  async start(workflow: Workflow, workflowUri: string, repositoryUri: string, taskUri?: string, context?: Omit<ExecutionContext, 'runId'>, recovery?: Run['recovery'], guidance?: Run['guidance'], finalization?: Run['finalization']): Promise<Run> {
    const snapshot = parseWorkflow(JSON.stringify(workflow));
    const run: Run = { version: 1, id: randomUUID(), workflow: snapshot, workflowUri, repositoryUri, taskUri, taskId: context?.taskId, story: context?.story,
      ...(finalization ? { finalization } : {}), ...(recovery ? { recovery } : {}), ...(guidance ? { guidance: structuredClone(guidance) } : {}), status: 'queued', createdAt: now(), updatedAt: now(), steps: Object.fromEntries(snapshot.nodes.map(node => [node.id, { status: 'queued' }])) };
    parseRun(JSON.stringify(run));
    await this.launch(run, context);
    return structuredClone(run);
  }
  async recover(saved: Run, mode: 'fresh' | 'retry', context: Omit<ExecutionContext, 'runId'>): Promise<Run> {
    const source = parseRun(JSON.stringify(saved));
    if (source.finalization) throw new Error('Use Finish early to request a new wrap-up or closure with current context.');
    if (mode === 'retry' && Object.values(source.steps).some(step => step.skipReason)) throw new Error('Skipped phases require a fresh workflow with new approvals.');
    if (!['failed', 'cancelled', 'interrupted'].includes(source.status) || this.isActive(source.id)) throw new Error('Only stopped unsuccessful runs can recover.');
    if (source.story) throw new Error('Recover story runs from the epic using its current eligibility checks.');
    if (!['fresh', 'retry'].includes(mode)) throw new Error('Invalid recovery mode.');
    const nodes = orderedNodes(source.workflow);
    const index = nodes.findIndex(node => source.steps[node.id].status !== 'succeeded');
    if (index < 0 || !['failed', 'cancelled', 'interrupted', 'queued'].includes(source.steps[nodes[index].id].status)) throw new Error('No failed or interrupted phase can be retried.');
    if (nodes.slice(index + 1).some(node => source.steps[node.id].status === 'succeeded')) throw new Error('Saved phase order is inconsistent. Start a fresh workflow.');
    if (mode === 'retry' && nodes.slice(0, index).some(node => typeof source.steps[node.id].output !== 'string')) throw new Error('An earlier phase has no saved result. Start a fresh run.');
    if (context.taskId !== source.taskId) throw new Error('Recovery task identity changed.');
    await context.validate();
    const run: Run = { version: 1, id: randomUUID(), workflow: source.workflow, workflowUri: source.workflowUri, repositoryUri: source.repositoryUri, taskUri: source.taskUri, taskId: source.taskId,
      guidance: source.guidance, recovery: { fromRunId: source.id, fromNodeId: nodes[index].id, mode }, status: 'queued', createdAt: now(), updatedAt: now(),
      steps: Object.fromEntries(nodes.map((node, position) => [node.id, mode === 'retry' && position < index ? { status: 'succeeded', output: source.steps[node.id].output, startedAt: source.steps[node.id].startedAt, finishedAt: source.steps[node.id].finishedAt, context: source.steps[node.id].context, usage: source.steps[node.id].usage } : { status: 'queued', ...(mode === 'retry' && position === index ? { previousOutput: (source.steps[node.id].output ?? source.steps[node.id].previousOutput)?.slice(0, 32000) } : {}) }])) };
    const recoveryContext = { ...context, data: JSON.stringify({ currentContext: context.data, recovery: { ...run.recovery, previousError: source.error, failedOutput: source.steps[nodes[index].id].output ?? source.steps[nodes[index].id].previousOutput, failedTranscript: source.steps[nodes[index].id].liveOutput, instruction: 'Inspect the current repository for partial effects before acting. Retained prior results are human-confirmed working data, not new authorization. Do not duplicate completed edits or external actions.' } }) };
    await this.launch(run, recoveryContext);
    return structuredClone(run);
  }
  async adoptEpicIdentity(saved: Run, epicUri: string, epicId: string): Promise<void> {
    if (this.isActive(saved.id)) throw new Error('Finish the story run before adopting epic identity.');
    if (!saved.story || saved.story.epicUri !== epicUri || saved.story.epicId) return;
    const run = parseRun(JSON.stringify({ ...saved, story: { ...saved.story, epicId } }));
    await this.persist(run);
  }
  async recordReview(saved: Run, review: NonNullable<Run['review']>): Promise<void> {
    if (this.isActive(saved.id)) throw new Error('Finish or cancel the run before accepting work.');
    const run = parseRun(JSON.stringify({ ...saved, review }));
    await this.persist(run);
  }
  async resume(saved: Run): Promise<void> {
    const run = parseRun(JSON.stringify(saved));
    if (!['interrupted', 'waitingApproval'].includes(run.status)) throw new Error('Only interrupted or paused runs can be resumed.');
    if (run.story) throw new Error('Story runs cannot be replayed. Refresh the epic and start its current eligible story.');
    if (run.workflow.nodes.some(node => node.kind === 'agent' && node.config.provider !== 'mock')) throw new Error('Live runs cannot be replayed. Review repository changes and start a new run; the native session ID is saved.');
    // shortcut: only the side-effect-free mock can restart an interrupted step; real providers need recovery decisions.
    for (const [id, step] of Object.entries(run.steps)) if (step.status !== 'succeeded') run.steps[id] = { status: 'queued' };
    run.status = 'queued'; delete run.error;
    await this.launch(run);
  }
  private async launch(run: Run, context?: Omit<ExecutionContext, 'runId'>): Promise<void> {
    if ([...this.active.values()].some(active => active.run.repositoryUri === run.repositoryUri)) throw new Error('A run is already active for this repository.');
    let release: (() => Promise<void>) | undefined;
    if (run.workflow.nodes.some(node => node.kind === 'agent' && node.config.provider !== 'mock')) {
      if (!context) throw new Error('Live runs require a bound execution context.');
      await context.validate();
      const repository = await realpath(context.repository);
      const key = createHash('sha256').update(process.platform === 'win32' ? repository.toLowerCase() : repository).digest('hex');
      await mkdir(this.lockRoot, { recursive: true });
      const lock = path.join(this.lockRoot, `${key}.lock`);
      let handle;
      try { handle = await open(lock, 'wx'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error(`Another live run owns this repository. If its host crashed, verify no agent is running before removing ${lock}.`); throw error; }
      try { await handle.writeFile(JSON.stringify({ runId: run.id, pid: process.pid, repository, createdAt: now() })); }
      catch (error) { await handle.close(); await unlink(lock); throw error; }
      release = async () => { await handle.close(); await unlink(lock); };
    }
    const active = { run, context, controller: new AbortController(), done: Promise.resolve() };
    this.active.set(run.id, active);
    try { await this.persist(run); }
    catch (error) { this.active.delete(run.id); await release?.(); throw error; }
    active.done = this.execute(run, active.controller.signal).catch(this.failed).finally(async () => { this.active.delete(run.id); if (!run.error?.includes('shutdown could not be confirmed')) await release?.(); }).catch(this.failed);
  }
  private async execute(run: Run, signal: AbortSignal): Promise<void> {
    let current: string | undefined;
    try {
      for (const node of orderedNodes(run.workflow)) {
        if (run.steps[node.id].status === 'succeeded' || run.steps[node.id].skipReason) continue;
        signal.throwIfAborted(); await this.active.get(run.id)?.context?.validate(); await this.active.get(run.id)?.context?.checkMemory?.();
        if (run.steps[node.id].skipReason) continue;
        current = node.id;
        const step = run.steps[node.id]; step.startedAt = now();
        run.status = step.status = node.kind === 'approval' ? 'waitingApproval' : 'running';
        if (node.kind === 'approval') {
          let finish!: () => void;
          const wait = new Promise<void>(resolve => { finish = resolve; });
          const active = this.active.get(run.id)!;
          active.approve = finish;
          signal.addEventListener('abort', finish, { once: true });
          try { await this.persist(run); await wait; signal.throwIfAborted(); }
          finally { signal.removeEventListener('abort', finish); active.approve = undefined; }
          step.output = 'Approved by the user.';
        } else {
          const host = this.active.get(run.id)!.context;
          while (true) {
            const prerequisites = await host?.memoryPrerequisites?.(node) ?? [];
            if (prerequisites.length) await this.waitForMemory(run, node.id, prerequisites, signal);
            signal.throwIfAborted(); await host?.checkMemory?.();
            if (step.output !== undefined) { step.previousOutput = step.output; delete step.output; }
            run.status = step.status = 'running';
            step.activity = step.previousOutput ? 'Continuing from previous phase checkpoint' : 'Starting agent';
            await this.persist(run);
            let lastOutput = 0;
            const recordActivity = (summary: string) => { step.activity = summary.slice(0, 300); step.lastActivityAt = now(); step.events = [...(step.events ?? []), { at: step.lastActivityAt, summary: step.activity }].slice(-30); };
            let interactions = Promise.resolve();
            const interact = <T>(summary: string, action: () => Promise<T>): Promise<T> => {
              const next = interactions.then(async () => {
                signal.throwIfAborted(); run.status = step.status = 'waitingApproval'; step.toolApproval = true;
                recordActivity(summary); await this.persist(run);
                try { const value = await action(); signal.throwIfAborted(); await host!.validate(); await host!.checkMemory?.(); return value; }
                finally { delete step.toolApproval; if (!signal.aborted) { run.status = step.status = 'running'; await this.persist(run); } }
              });
              interactions = next.then(() => {}, () => {}); return next;
            };
            const context: ExecutionContext | undefined = host && { ...host, validate: async () => { await host.validate(); await host.checkMemory?.(); }, runId: run.id, readOnly: Boolean(host.readOnly || node.config.readOnly),
              data: JSON.stringify({ context: host.data, decisions: run.guidance ?? [], skippedSteps: Object.fromEntries(Object.entries(run.steps).filter(([,state])=>state.skipReason).map(([id,state])=>[id,state.skipReason])), continuation: step.previousOutput ? { nodeId: node.id, previousReport: step.previousOutput, instruction: 'This is a prior attempt checkpoint, not a current result or authorization. Compare it with refreshed saved memory and current repository effects. Continue remaining work; do not recreate an already-applied proposal or repeat completed actions. Recheck stale evidence when needed.' } : undefined, previousSteps: Object.fromEntries(Object.entries(run.steps).filter(([, state]) => state.status === 'succeeded').map(([id, state]) => [id, state.output])) }),
              activity: async summary => { signal.throwIfAborted(); recordActivity(summary); await this.persist(run); },
              output: async text => { signal.throwIfAborted(); step.liveOutput = text.slice(-32000); step.lastActivityAt = now(); if (Date.now() - lastOutput >= 250) { lastOutput = Date.now(); await this.persist(run); } },
              usage: async usage => { signal.throwIfAborted(); if (validUsage(usage)) { step.usage = structuredClone(usage); await this.persist(run); } },
              session: async id => { signal.throwIfAborted(); step.providerSessionId = id.slice(0, 200); recordActivity('Connected to provider session'); await this.persist(run); },
              approval: async (summary, details, request) => {
                const gated = context!.readOnly || Boolean((node.config.agentSnapshot as { approval_gate?: string } | undefined)?.approval_gate);
                const eligible = gated ? undefined : request;
                signal.throwIfAborted(); await context!.validate();
                if (eligible && await host.automaticApproval?.(eligible)) {
                  signal.throwIfAborted(); await context!.validate();
                  recordActivity(`Automatically allowed: ${summary} (${eligible.paths.join(", ")})`); await this.persist(run); return true;
                }
                return interact(summary, () => host.approval(summary, details, eligible));
              },
              input: question => interact(question.question, () => host.input(question, signal))
            };
            if (context) { step.context = preparedContext(context.system, executionPrompt(node, context), host?.contextSources?.() ?? []); delete step.usage; await this.persist(run); }
            await host?.beforeExecute?.();
            step.output = (await this.provider.execute(node, signal, context)).slice(0, 32000);
            await host?.checkMemory?.();
            if (node.config.requireVerification) {
              const report = parseVerificationReport(step.output);
              if (report.status === 'blocked') {
                const required = await host?.memoryPrerequisites?.(node) ?? [];
                if (required.length) { await this.waitForMemory(run, node.id, required, signal); continue; }
                if (host?.input && context) {
                  if ((run.guidance?.length ?? 0) >= 32) throw new Error('Guidance history is full. Save a reviewed task handoff before starting a new run.');
                  const question = {
                    header: node.label,
                    question: `How should ${node.label} continue?`,
                    details: report.summary,
                    recommendation: 'Ask the agent to continue available diagnostic checks. Tool permissions are requested separately. If an approved prerequisite must change, choose Prepare revised plan for review.',
                    options: [
                      {label:'Continue investigation',description:'Try available read-only checks within existing permissions and report what still blocks progress.'},
                      {label:'Prepare revised plan',description:'Propose a focused amendment to the existing plan for review. Keep unverified acceptance checks visible.'}
                    ],
                    cancelLabel: 'Stop run'
                  };
                  const answer = await context.input(question);
                  signal.throwIfAborted();
                  if (!answer?.trim()) { this.active.get(run.id)!.controller.abort('Stopped while awaiting guidance.'); signal.throwIfAborted(); }
                  if (answer!.length > 16000) throw new Error('Guidance exceeds 16000 characters.');
                  const selectedOption = question.options.find(option => option.label === answer);
                  const guidance = selectedOption ? `${selectedOption.label}: ${selectedOption.description}` : answer!;
                  (run.guidance ??= []).push({ nodeId: node.id, report: step.output, answer: guidance });
                  await this.persist(run);
                  if (host?.refreshMemory) host.data = await host.refreshMemory();
                  delete step.liveOutput; delete step.providerSessionId;
                  continue;
                }
              }
              if (report.status !== 'passed') throw new Error(`${node.label}: ${report.status} - ${report.summary}`);
            }
            signal.throwIfAborted(); await host?.validate();
            break;
          }
        }
        signal.throwIfAborted(); await this.active.get(run.id)?.context?.validate(); await this.active.get(run.id)?.context?.checkMemory?.();
        step.status = 'succeeded'; step.finishedAt = now(); run.status = 'running';
        await this.persist(run);
      }
      signal.throwIfAborted();
      if (Object.values(run.steps).some(step => step.skipReason)) { run.status = 'cancelled'; run.error = 'Ended with skipped optional phases. Skipped work is unverified; the task remains open.'; }
      else run.status = 'succeeded';
    } catch (error) {
      const contextChanged = error instanceof ContextChangedError ? error : signal.reason instanceof ContextChangedError ? signal.reason : undefined;
      run.status = contextChanged ? 'interrupted' : signal.aborted ? signal.reason === 'shutdown' ? 'interrupted' : 'cancelled' : 'failed';
      if (!signal.aborted) run.error = String(error).slice(0, 2000);
      else if (signal.reason !== 'shutdown') run.error = typeof signal.reason === 'string' ? signal.reason : 'Cancelled by the user.';
      else run.error = run.workflow.nodes.some(node => node.kind === 'agent' && node.config.provider !== 'mock')
        ? 'Interrupted by extension shutdown. Review existing edits before starting another run.'
        : 'Interrupted by extension shutdown. Resume explicitly from Run History.';
      if (contextChanged) run.error = contextChanged.message;
      if (String(error).includes('shutdown could not be confirmed')) run.error = String(error);
      if (current && run.steps[current].status !== 'succeeded') {
        run.steps[current].status = run.status; run.steps[current].finishedAt = now();
      }
    }
    await this.persist(run);
  }
  private async waitForMemory(run: Run, nodeId: string, files: string[], signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    const active = this.active.get(run.id)!; const step = run.steps[nodeId];
    run.status = step.status = 'waitingApproval'; step.memoryApproval = files; step.activity = 'Waiting for memory approval';
    let finish!: () => void; const waiting = new Promise<void>(resolve => { finish = resolve; });
    active.resumeMemory = finish; signal.addEventListener('abort', finish, { once: true });
    try {
      await this.persist(run); await waiting; signal.throwIfAborted();
      await active.context!.memoryReady!(files); await active.context!.validate();
      if (active.context!.refreshMemory) active.context!.data = await active.context!.refreshMemory();
      delete step.liveOutput; delete step.providerSessionId;
    } finally { signal.removeEventListener('abort', finish); active.resumeMemory = undefined; delete step.memoryApproval; }
  }
  async continueMemory(id: string): Promise<void> {
    const active = this.active.get(id); const step = active && Object.values(active.run.steps).find(step => step.memoryApproval);
    if (!active?.resumeMemory || !step?.memoryApproval || !active.context?.memoryReady) throw new Error('No memory approval is pending for this run.');
    const resume = active.resumeMemory;
    await active.context.memoryReady(step.memoryApproval); await active.context.validate();
    if (active.controller.signal.aborted || active.resumeMemory !== resume) throw new Error('The memory wait changed. Refresh the run.');
    active.resumeMemory = undefined; resume();
  }
  approve(id: string, expectedNodeId?: string): void {
    const active = this.active.get(id);
    if (!active?.approve || active.run.status !== 'waitingApproval') throw new Error('This run is not waiting for approval.');
    if (expectedNodeId !== undefined && (active.run.steps[expectedNodeId]?.status !== 'waitingApproval' || active.run.workflow.nodes.find(node => node.id === expectedNodeId)?.kind !== 'approval')) throw new Error('This approval request is stale. Review the current phase.');
    const approve = active.approve; active.approve = undefined; approve();
  }
  async revalidate(): Promise<void> {
    await Promise.all([...this.active.values()].map(async active => {
      try {
        await active.context?.validate();
        if (!Object.values(active.run.steps).some(step => step.memoryApproval)) await active.context?.checkMemory?.();
      } catch (error) { active.controller.abort(error instanceof ContextChangedError ? error : `Authorization changed: ${String(error)}`); }
    }));
  }
  async skipOptional(id: string, nodeIds: string[], reason: string): Promise<void> {
    const active = this.active.get(id);
    if (!active || active.controller.signal.aborted || active.run.story || active.run.finalization) throw new Error('Choose an active regular workflow.');
    if (!reason.trim() || reason.length > 16000 || !nodeIds.length || new Set(nodeIds).size !== nodeIds.length) throw new Error('Choose optional phases and give a reason.');
    const run = active.run;
    const nodes = nodeIds.map(id => run.workflow.nodes.find(node => node.id === id));
    await active.context?.validate(); await active.context?.checkMemory?.();
    if (active.controller.signal.aborted || nodes.some(node => !node || !skippable(node) || run.steps[node.id].status !== 'queued')) throw new Error('Only pending optional informational phases can be skipped.');
    for (const node of nodes) run.steps[node!.id] = { status: 'cancelled', skipReason: reason.trim(), finishedAt: now(), activity: 'Skipped by user; unverified' };
    await this.persist(run);
  }
  cancel(id: string): void { this.active.get(id)?.controller.abort(); }
  async wait(id: string): Promise<void> { await this.active.get(id)?.done; }
  async stop(): Promise<void> { for (const active of this.active.values()) active.controller.abort('shutdown'); await Promise.all([...this.active.values()].map(active => active.done)); }
  isActive(id: string): boolean { return this.active.has(id); }
}
