import { runDescription } from '../core/task-ux';
import { RecoveryPresenter } from './editor';
import { confirmation } from './confirmation';
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash } from '../framework/memory-proposal';
import { randomUUID } from 'node:crypto';
import { dashboardEntries, dashboardContent } from '../framework/dashboard';
import { DashboardState, DashboardPage, RecoveryPrompt, CreationDraft, dashboardPages, handoffPrompt, parseDashboardMessage } from '../dashboard-contracts';
import { WorkspaceBinding, requireTrust, workspacePaths } from './binding';
import { taskSnapshot, editTask, TaskEdit } from '../framework/task-edit';
import { agentEntries, createAgent, defaultAgentInstructions, parseAgent } from '../framework/agents';
import { taskActivity } from '../core/task-activity';
import { ContextPreviews } from './context';
import { executionContext } from './execution';
import { ProviderRouter } from '../providers/router';
import { AgentProvider } from '../providers/mock';
import { prepareTask } from '../framework/task-draft';
import { Run } from '../contracts';
import { repositoryTargets, resolveRepository, detectedConfiguration, inside } from '../framework/workspace';
import path from 'node:path';
import { StorySelection } from './epics';
import { TaskBinding } from '../framework/tasks';
import { appendHandoff } from '../framework/handoff';
import { parseEpic } from '../framework/epics';
import { reviewedEpic } from '../framework/epic-edit';
import { applyProposal, parseProposal, proposalState } from '../framework/memory-proposal';
import { reviewMemory } from './memory';
import { repositoryReview } from '../core/review';
import { readText } from '../core/files';
import { createTask, readBinding, sidecar } from '../framework/tasks';
import { adoptExistingTask, Item, WorkspaceFiles } from './workspace';

const commands = { createAgent: 'aiOs.createAgent', createTask: 'aiOs.createTask', adoptTask: 'aiOs.adoptTask', createWorkflow: 'aiOs.createWorkflow',
  selectFramework: 'aiOs.selectFramework', initialize: 'aiOs.initialize', showRuns: 'aiOs.showRuns' } as const;
export class Dashboard implements vscode.Disposable {
  page: DashboardPage = 'task';
  private changedPage = new vscode.EventEmitter<DashboardPage>();
  readonly onDidChangePage = this.changedPage.event;
  private panel?: vscode.WebviewPanel;
  private runRefresh?: ReturnType<typeof setTimeout>;
  private revision = 0;
  private state?: DashboardState;
  private selected?: string;
  private creation?: CreationDraft;
  private drafting?: { requestId: string; controller: AbortController };
  private draftProvider: AgentProvider;
  private recovery?: {prompt:RecoveryPrompt;finish:(choice?:string)=>void};
  private queue = Promise.resolve();
  private subscriptions: vscode.Disposable[];
  constructor(private binding: WorkspaceBinding, private extensionUri: vscode.Uri, private files: WorkspaceFiles, private history: () => Run[], private showRun: (run: Run) => Promise<void>, private isActive: (id: string) => boolean, private previews: ContextPreviews, private runStory?: (task: TaskBinding, selection?: StorySelection) => Promise<void>, private acceptReview?: (run: Run, review: NonNullable<Run['review']>) => Promise<void>, private adoptEpic?: (uri: string, identity: string) => Promise<void>, private recoverRun?: (run:Run,present:RecoveryPresenter)=>Promise<Run|undefined>, private finishRun?: (run:Run,mode:'skip'|'wrap'|'close',reason:string,nodeIds:string[])=>Promise<Run|undefined>) {
    this.draftProvider = new ProviderRouter(vscode.Uri.joinPath(extensionUri, 'dist/claude-worker.mjs').fsPath);
    this.subscriptions = [binding.onDidChange(() => this.scheduleRefresh()),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.scheduleRefresh()),
      vscode.workspace.onDidChangeTextDocument(event => {
        if (this.selected && event.document.uri.toString() === vscode.Uri.joinPath(vscode.Uri.file(this.state?.root ?? ''), this.selected).toString()) this.scheduleRefresh();
      })];
  }
  dispose() { this.recovery?.finish(); clearTimeout(this.runRefresh); this.drafting?.controller.abort('shutdown'); this.changedPage.dispose(); this.panel?.dispose(); this.subscriptions.forEach(item => item.dispose()); }
  updateRun(run: Run): void {
    const entry = this.state?.entries.find(entry => entry.id === this.selected);
    if (!Object.values(run.steps).some(step => step.memoryApproval) && entry && this.state && inside(this.state.root, vscode.Uri.parse(run.workflowUri).fsPath) && (entry.id === 'run:' + run.id || entry.kind === 'task' && (entry.runId === run.id || entry.taskId && entry.taskId === run.taskId))) void this.panel?.webview.postMessage({ type: 'execution', id: entry.id, revision: this.state.revision, run, active: this.isActive(run.id) });
    if (this.panel && !this.runRefresh) this.runRefresh = setTimeout(() => { this.runRefresh = undefined; this.scheduleRefresh(); }, 500);
  }
  private scheduleRefresh() {
    if (!this.panel) return;
    this.queue = this.queue.then(() => this.refresh()).catch(error => this.error(error));
  }
  private askRecovery(message:string, options:{detail?:string;review?:string}, choices:string[]):Promise<string|undefined> {
    if (!this.panel || this.recovery) throw new Error('Recovery panel is unavailable.');
    const panel=this.panel; const prompt:RecoveryPrompt={type:'recoveryPrompt',requestId:randomUUID(),message,detail:options.detail??'',review:options.review,choices};
    return new Promise(resolve=>{
      const finish=(choice?:string)=>{if(this.recovery?.prompt.requestId!==prompt.requestId)return;this.recovery=undefined;void panel.webview.postMessage({type:'recoveryClosed',requestId:prompt.requestId});resolve(choice);};
      this.recovery={prompt,finish}; void panel.webview.postMessage(prompt).then(sent=>{if(!sent)finish();},()=>finish());
    });
  }
  private async error(error: unknown) { await this.panel?.webview.postMessage({ type: 'error', message: String(error) }); }
  async show(page?: DashboardPage): Promise<void> {
    if (page !== undefined && !(dashboardPages as readonly string[]).includes(page)) throw new Error('Unsupported dashboard page.');
    if (this.panel) { this.panel.reveal(); await this.refresh(); if (page) await this.panel.webview.postMessage({ type: 'navigate', page }); return; }
    if (page) this.page = page;
    const panel = vscode.window.createWebviewPanel('aiOs.dashboard', 'AI OS Workspace', vscode.ViewColumn.One, {
      enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')], retainContextWhenHidden: true,
    });
    this.panel = panel;
    const asset = (name: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', name));
    const nonce = randomUUID().replaceAll('-', '');
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; connect-src 'none';"><link rel="stylesheet" href="${asset('dashboard.css')}"></head><body data-page="${this.page}"><div id="root"></div><script nonce="${nonce}" src="${asset('dashboard.js')}"></script></body></html>`;
    const listener = panel.webview.onDidReceiveMessage(raw => {
      try {
        const message = parseDashboardMessage(raw);
        if (message.type === 'answerRecovery') { void this.handle(message).catch(error=>this.error(error)); return; }
        if (message.type === 'cancelCreation' && this.drafting?.requestId === message.requestId) { this.drafting.controller.abort('cancelled'); this.creation = undefined; void panel.webview.postMessage({ type: 'creationCancelled', requestId: message.requestId }); return; }
      } catch { /* Invalid messages are reported through the normal queue. */ }
      this.queue = this.queue.then(() => this.handle(raw)).catch(error => this.error(error));
    });
    panel.onDidDispose(() => { this.recovery?.finish(); listener.dispose(); this.drafting?.controller.abort('closed'); if (this.panel === panel) { this.panel = undefined; this.state = undefined; this.selected = undefined; this.creation = undefined; } });
  }
  async refresh(): Promise<void> {
    const panel = this.panel; if (!panel) return;
    const root = await this.binding.current();
    const entries = root ? await dashboardEntries(root.uri.fsPath, workspacePaths()) : [];
    if (root) {
      for (const entry of entries.filter(entry => entry.kind === 'task')) {
        const activity = taskActivity(vscode.Uri.joinPath(root.uri, entry.id).toString(), this.history(), this.isActive, entry.taskId);
        const updatedAt = [entry.updatedAt, activity.updatedAt].filter((value): value is string => Boolean(value)).sort((a, b) => Date.parse(a) - Date.parse(b)).at(-1);
        Object.assign(entry, activity, { updatedAt });
      }
      for (const entry of entries.filter(entry => entry.epic)) for (const story of entry.epic!.stories) {
        const run = this.history().filter(run => run.story && (entry.epic!.identity && run.story.epicId ? run.story.epicId === entry.epic!.identity : run.story.epicUri === vscode.Uri.joinPath(root.uri, entry.id).toString()) && run.story.id === story.id).sort((a, b) => Number(this.isActive(b.id)) - Number(this.isActive(a.id)) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
        if (run) story.run = { id: run.id, status: run.status, active: this.isActive(run.id) };
      }
      for (const target of await repositoryTargets(workspacePaths())) {
        const directory = await resolveRepository(root.uri.fsPath, target, workspacePaths());
        entries.push({ id: 'repository:' + JSON.stringify(target), title: path.basename(directory), kind: 'repository', category: 'Repositories', repository: directory });
      }
      for (const run of this.history().filter(run => inside(root.uri.fsPath, vscode.Uri.parse(run.workflowUri).fsPath))) {
        const task = entries.find(entry => entry.kind === 'task' && (run.taskId ? entry.taskId === run.taskId : vscode.Uri.joinPath(root.uri, entry.id).toString() === run.taskUri));
        entries.push({ id: 'run:' + run.id, ...runDescription(run, task?.title), kind: 'run', category: run.status, runActive: this.isActive(run.id), updatedAt: run.updatedAt, repository: vscode.Uri.parse(run.repositoryUri).fsPath });
      }
    }
    const state: DashboardState = { type: 'dashboard', revision: this.revision, root: root?.uri.fsPath ?? '',
      trusted: vscode.workspace.isTrusted, entries, problem: this.binding.problem || undefined };
    if (this.panel !== panel) return;
    const index = (value: DashboardState) => JSON.stringify([value.root, value.trusted, value.entries, value.problem]);
    if (!this.state || index(this.state) !== index(state)) state.revision = ++this.revision;
    if (this.state?.root !== state.root) this.selected = undefined;
    this.state = state;
    if (!entries.some(entry => entry.id === this.selected)) this.selected = undefined;
    await panel.webview.postMessage(state);
    if (this.selected) await this.preview(this.selected);
    if (this.creation?.root === state.root) await panel.webview.postMessage(this.creation);
    else this.creation = undefined;
  }
  async create(kind: 'task' | 'agent', templateFile?: string): Promise<void> {
    requireTrust(); const root = await this.binding.require();
    if (this.creation?.root === root.uri.fsPath) { await this.show(this.creation.kind); await this.refresh(); return; }
    await this.show(kind);
    const repositories = [];
    for (const target of await repositoryTargets(workspacePaths())) {
      const directory = await resolveRepository(root.uri.fsPath, target, workspacePaths());
      repositories.push({ label: directory, target });
    }
    const agents = (await agentEntries(root.uri.fsPath)).filter(entry => entry.agent && !entry.template && !entry.problem).map(entry => ({ id: entry.agent!.id, name: entry.agent!.name, provider: entry.agent!.provider }));
    requireTrust();
    if ((await this.binding.require()).uri.fsPath !== root.uri.fsPath) throw new Error('Framework changed. Start creation again.');
    const raw = templateFile ? await readText(root.uri.fsPath, templateFile) : undefined;
    const template = raw ? parseAgent(raw) : undefined;
    this.creation = { type: 'creationDraft', requestId: randomUUID(), kind, root: root.uri.fsPath, repositories, agents, instructions: template?.instructions ?? defaultAgentInstructions, ...(template && raw ? { template: { file: templateFile!, hash: hash(raw), name: template.name, provider: template.provider, model: template.model } } : {}) };
    await this.refresh();
  }
  private async memoryReady(run?: Run): Promise<boolean | undefined> {
    const files = run && Object.values(run.steps).find(step => step.memoryApproval)?.memoryApproval;
    if (!files) return;
    try {
      const root = await this.binding.require();
      for (const file of files) if (await proposalState(root.uri.fsPath, parseProposal(await readText(root.uri.fsPath, file))) !== 'applied') return false;
      return true;
    } catch { return false; }
  }
  private async preview(id: string) {
    const state = this.state!;
    const entry = state.entries.find(entry => entry.id === id)!;
    try {
      if (entry.kind === 'run') {
        const run = this.history().find(run => entry.id === 'run:' + run.id);
        if (!run) throw new Error('Run no longer exists.');
        await this.panel?.webview.postMessage({ type: 'execution', id, revision: state.revision, run, active: this.isActive(run.id), memoryReady: await this.memoryReady(run) });
        await this.panel?.webview.postMessage({ type: 'detail', id, revision: state.revision, content: JSON.stringify(run, null, 2) }); return;
      }
      if (entry.kind === 'repository') {
        const target = JSON.parse(entry.id.slice('repository:'.length));
        const directory = await resolveRepository(state.root, target, workspacePaths());
        await this.panel?.webview.postMessage({ type: 'detail', id, revision: state.revision, content: JSON.stringify({ directory, existingConfiguration: await detectedConfiguration(directory) }, null, 2) }); return;
      }
      if (entry.kind === 'task') {
        const run = this.history().find(run => run.id === entry.runId);
        await this.panel?.webview.postMessage({ type: 'execution', id, revision: state.revision, run, active: run ? this.isActive(run.id) : false, memoryReady: await this.memoryReady(run) });
      }
      const disk = await dashboardContent(state.root, entry);
      const uri = vscode.Uri.joinPath(vscode.Uri.file(state.root), id).toString();
      const document = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri);
      await this.panel?.webview.postMessage({ type: 'detail', id, revision: state.revision, content: document?.getText() ?? disk, unsaved: document?.isDirty ?? false });
    } catch (error) { await this.panel?.webview.postMessage({ type: 'detail', id, revision: state.revision, content: '', problem: String(error) }); }
  }
  private async sendDraft(id: string, root: string, saved?: string) {
    const snapshot = await taskSnapshot(root, id);
    const binding = await readBinding(root, id);
    if (this.state?.root !== root) throw new Error('Framework changed. Reload the task.');
    await this.panel?.webview.postMessage({ type: saved ? 'taskSaved' : 'taskDraft', id, root, saved,
      ...snapshot, title: binding?.title ?? '', status: binding?.status ?? 'open', archived: binding?.archived ?? false,
      agentId: binding?.agentId, agents: (await agentEntries(root)).filter(entry => entry.agent && !entry.template && !entry.problem).map(entry => ({ id: entry.agent!.id, name: entry.agent!.name, provider: entry.agent!.provider })),
      bound: Boolean(binding), editableNotes: !snapshot.content.includes('<!-- AIOS-ENTRY') });
  }
  async handle(raw: unknown): Promise<void> {
    const envelope = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : undefined;
    if (typeof envelope?.operationId === 'string' && /^[a-f0-9-]{36}$/.test(envelope.operationId)) {
      const panel = this.panel; const operationId = envelope.operationId;
      try {
        const { operationId: _operationId, ...request } = parseDashboardMessage(raw);
        await this.handle(request);
      } finally { await panel?.webview.postMessage({ type: 'operationComplete', operationId }); }
      return;
    }
    const message = parseDashboardMessage(raw);
    if (message.type === 'answerRecovery') {
      const pending=this.recovery;
      if (!pending || pending.prompt.requestId!==message.requestId) throw new Error('Recovery question expired.');
      if (message.choice!==null && message.choice>=pending.prompt.choices.length) throw new Error('Invalid recovery choice.');
      pending.finish(message.choice===null?undefined:pending.prompt.choices[message.choice]); return;
    }
    if (message.type === 'navigate') { this.page = message.page; this.changedPage.fire(message.page); return; }
    if (message.type === 'action') {
      if (message.action === 'createTask' || message.action === 'createAgent') return this.create(message.action === 'createTask' ? 'task' : 'agent');
      if (message.action === 'refresh') return this.refresh();
      if (!['showRuns'].includes(message.action)) requireTrust();
      await vscode.commands.executeCommand(commands[message.action]); await this.refresh(); return;
    }
    if (message.type === 'cancelCreation') {
      if (this.creation?.requestId === message.requestId) { this.drafting?.controller.abort('cancelled'); this.creation = undefined; }
      await this.panel?.webview.postMessage({ type: 'creationCancelled', requestId: message.requestId });
      return;
    }
    if (message.type === 'prepareTask') {
      requireTrust(); const root = await this.binding.require(); const draft = this.creation;
      if (!draft || draft.kind !== 'task' || draft.requestId !== message.requestId || draft.root !== root.uri.fsPath) throw new Error('Creation form expired. Start again.');
      const target = draft.repositories[message.repository]?.target;
      if (!target) throw new Error('Choose a repository from this form.');
      delete draft.prepared;
      const controller = new AbortController(); this.drafting = { requestId: draft.requestId, controller };
      const timer = setTimeout(() => controller.abort('timeout'), 120000);
      try {
        const context = await executionContext(this.binding, this.previews, null, target);
        const prepared = await prepareTask(this.draftProvider, { ...context, runId: randomUUID(), readOnly: true }, { description: message.description, title: message.title, provider: message.provider }, controller.signal);
        if (this.creation !== draft) return;
        draft.prepared = { ...prepared, id: randomUUID(), repository: message.repository };
        await this.panel?.webview.postMessage({ type: 'taskPrepared', requestId: draft.requestId, root: draft.root, prepared: draft.prepared });
        await this.panel?.webview.postMessage({ type: 'notice', message: 'Draft prepared. Review its title and notes, then Save task to file it.' });
      } catch (error) {
        if (controller.signal.aborted && controller.signal.reason !== 'timeout') return;
        throw controller.signal.reason === 'timeout' ? new Error('Task drafting timed out. Your inputs are preserved; try again.') : error;
      } finally { clearTimeout(timer); if (this.drafting?.controller === controller) this.drafting = undefined; }
      return;
    }
    if (message.type === 'createTask' || message.type === 'createAgent') {
      requireTrust(); const root = await this.binding.require(); const draft = this.creation;
      if (!draft || draft.requestId !== message.requestId || draft.root !== root.uri.fsPath || draft.kind !== (message.type === 'createTask' ? 'task' : 'agent')) throw new Error('Creation form expired. Start again.');
      let id: string;
      if (message.type === 'createTask') {
        if (!draft.prepared || message.draftId !== draft.prepared.id || message.repository !== draft.prepared.repository) throw new Error('Prepare and review a draft for this repository before saving.');
        const target = draft.repositories[message.repository]?.target;
        if (!target) throw new Error('Choose a repository from this form.');
        await resolveRepository(draft.root, target, workspacePaths());
        if (message.agentId && !draft.agents.some(agent => agent.id === message.agentId)) throw new Error('Choose an available agent from this form.');
        const task = await createTask(draft.root, message.title.trim(), target, workspacePaths(), { notes: message.notes, agentId: message.agentId });
        id = task.note;
      } else {
        if (draft.template && hash(await readText(draft.root, draft.template.file)) !== draft.template.hash) throw new Error('Template changed. Reopen the creation form.');
        id = await createAgent(draft.root, message.name.trim(), message.provider || null, { model: message.model.trim(), instructions: message.instructions, template: draft.template?.file });
      }
      this.creation = undefined; this.selected = id;
      await this.panel?.webview.postMessage({ type: 'creationSaved', requestId: draft.requestId, id, root: draft.root });
      await this.refresh();
      await this.panel?.webview.postMessage({ type: 'notice', message: draft.kind === 'task' ? 'Task created.' : 'Agent configuration created. No provider session was started.' });
      return;
    }
    const root = await this.binding.require();
    const state = this.state;
    if (!state || message.revision !== state.revision || root.uri.fsPath !== state.root) throw new Error('Dashboard changed. Refresh and select the item again.');
    const entry = state.entries.find(entry => entry.id === message.id);
    if (!entry) throw new Error('Item is not in this dashboard.');
    const linkedRun = () => this.history().find(run => entry.kind === 'run' ? entry.id === 'run:' + run.id : entry.kind === 'task' && run.id === entry.runId && (run.taskId === entry.taskId || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id).toString()));
    const idleRepository = (uri: string) => { if (this.history().some(run => this.isActive(run.id) && run.repositoryUri === uri)) throw new Error('Finish or cancel the repository run before review or editing.'); };
    if (message.type === 'linkRepository') {
      requireTrust();
      if (entry.kind !== 'task' || entry.archived || entry.problem || entry.properties) throw new Error('Choose an unlinked working task.');
      await adoptExistingTask(this.binding, { note: entry.id, title: entry.title });
      await this.refresh();
      return;
    }
    if (message.type === 'completeTask') {
      requireTrust();
      if (entry.kind !== 'task' || entry.problem || entry.archived || entry.status === 'done') throw new Error('Choose an open bound task.');
      const snapshot = await taskSnapshot(state.root, entry.id);
      const task = await readBinding(state.root, entry.id);
      if (!task) throw new Error('Adopt the task before completing it.');
      await this.handle({ type: 'saveProperties', id: entry.id, revision: state.revision, token: snapshot.token, title: task.title, status: 'done', ...(task.agentId ? { agentId: task.agentId } : {}) });
      return;
    }
    if (message.type === 'runTask') {
      requireTrust();
      if (entry.kind !== 'task' || entry.problem || entry.archived || entry.status === 'done') throw new Error('Choose an open bound task.');
      const task = await readBinding(state.root, entry.id);
      if (!task || !this.runStory) throw new Error('Adopt the task before running it.');
      if (entry.plan && state.entries.some(candidate => candidate.id === entry.plan && candidate.kind === 'epic')) throw new Error('Run the next eligible story from the linked epic.');
      const run = linkedRun();
      if (run && ['interrupted', 'failed', 'cancelled'].includes(run.status) && !run.review && await confirmation.show('Start a fresh run after reviewing the previous attempt?', { detail: 'Inspect saved output, provider session IDs and current repository changes first. This starts a new provider session; it does not replay or undo earlier edits.' }, 'Start fresh run') !== 'Start fresh run') return;
      await this.runStory(task); await this.refresh(); return;
    }
    if (message.type === 'recoverRun') {
      requireTrust(); const run = linkedRun();
      const required = run && Object.values(run.steps).find(step => step.memoryApproval)?.memoryApproval;
      if (run && required && this.isActive(run.id)) {
        await this.binding.workflowRoot(vscode.Uri.parse(run.workflowUri)); await this.binding.validateRunTarget(run.repositoryUri);
        for (const file of required) if (await proposalState(state.root, parseProposal(await readText(state.root, file))) !== 'applied') { await reviewMemory(this.binding, file, run.repositoryUri); await this.refresh(); return; }
        await this.panel?.webview.postMessage({ type: 'notice', message: 'Required proposals match saved memory. Select Continue after memory approval.' }); return;
      }
      if (!run || this.isActive(run.id) || !['failed', 'cancelled', 'interrupted'].includes(run.status)) throw new Error('Choose a stopped unsuccessful run.');
      idleRepository(run.repositoryUri); const recovered = this.recoverRun ? await this.recoverRun(run, (message,options,...choices)=>this.askRecovery(message,options,choices)) : await vscode.commands.executeCommand<Run | undefined>('aiOs.recoverRun', run.id); await this.refresh();
      if (recovered) {
        if (entry.kind === 'run') await this.panel?.webview.postMessage({ type: 'selectEntry', id: 'run:' + recovered.id, root: this.state!.root, revision: this.state!.revision });
        await this.panel?.webview.postMessage({ type: 'notice', message: `Recovery started: ${recovered.workflow.name}. A new run was created.` });
      } else await this.panel?.webview.postMessage({ type: 'notice', message: run.story ? 'Choose the current eligible story in Epics.' : 'Recovery cancelled. No new run was started.' });
      return;
    }
    if (message.type === 'approveRun') {
      requireTrust(); const run = linkedRun();
      if (!run || !this.isActive(run.id) || run.status !== 'waitingApproval' || Object.values(run.steps).some(step => step.toolApproval)) throw new Error('This run is not waiting for workflow approval.');
      await vscode.commands.executeCommand('aiOs.approveRun', run.id); return;
    }
    if (message.type === 'finishRun') {
      requireTrust(); const run = linkedRun();
      if (!run || run.id !== message.runId || !this.finishRun || run.story) throw new Error('Run selection changed or is not eligible.');
      const detail = message.mode === 'skip'
        ? 'Only the selected pending optional informational phases will be skipped. Required phases and approvals remain. Skipped work is unverified; this is not task completion.'
        : `The active agent will be stopped and its exit awaited before a new native ${message.mode === 'wrap' ? 'WRAP' : 'TASK_CLOSE'} session starts. Existing edits remain. Tool and memory approval gates still apply. ${message.mode === 'wrap' ? 'The task stays open.' : 'This requests the registered closure procedure; it does not mark the task done or approve semantic promotion/archival.'}`;
      const review = `Reason: ${message.reason}\n\nWorkflow: ${run.workflow.name}\nRepository: ${run.repositoryUri}\nSelected phases: ${message.nodeIds.join(', ') || 'None'}\n\n${run.workflow.nodes.map(node => `${node.label}: ${run.steps[node.id].skipReason ? 'Skipped (unverified)' : run.steps[node.id].status}`).join('\n')}`;
      if (await this.askRecovery('Finish early', {detail,review}, ['Confirm finish action']) !== 'Confirm finish action') return;
      const result = await this.finishRun(run, message.mode, message.reason, message.nodeIds);
      await this.refresh();
      if (result && entry.kind === 'run') await this.panel?.webview.postMessage({ type: 'selectEntry', id: 'run:' + result.id, root: this.state!.root, revision: this.state!.revision });
      else await this.preview(entry.id);
      return;
    }
    if (message.type === 'controlRun') { const run = linkedRun(); if (!run) throw new Error('No linked run.'); await this.showRun(run); return; }
    if (message.type === 'reviewChanges' || message.type === 'acceptRun') {
      requireTrust(); const run = linkedRun(); if (!run) throw new Error('No linked run to review.');
      idleRepository(run.repositoryUri); await this.binding.validateRunTarget(run.repositoryUri);
      const current = await repositoryReview(vscode.Uri.parse(run.repositoryUri).fsPath);
      if (message.type === 'reviewChanges') {
        await this.panel?.webview.postMessage({ type: 'reviewDraft', id: entry.id, root: state.root, runId: run.id, ...current }); return;
      }
      if (message.type !== 'acceptRun') throw new Error('Invalid review action.');
      if (current.token !== message.token || run.id !== message.runId || !this.acceptReview) throw new Error('Repository changed since review. Inspect it again before acceptance.');
      if (await confirmation.show('Record acceptance of the reviewed work?', { detail: 'Confirm verification and review notes are accurate. This receipt records human acceptance of the current repository state, including pre-existing changes. It does not mark tasks/stories done or promote memory.' }, 'Accept reviewed work') !== 'Accept reviewed work') return;
      requireTrust(); idleRepository(run.repositoryUri); await this.binding.validateRunTarget(run.repositoryUri);
      if ((await this.binding.require()).uri.fsPath !== state.root || (await repositoryReview(vscode.Uri.parse(run.repositoryUri).fsPath)).token !== message.token) throw new Error('Repository or framework changed during acceptance. Review again.');
      await this.acceptReview(run, { acceptedAt: new Date().toISOString(), repositoryToken: message.token, verification: message.verification, findings: message.findings });
      await this.refresh(); await this.panel?.webview.postMessage({ type: 'reviewSaved', id: entry.id }); return;
    }
    if (message.type === 'reviewProposal') {
      requireTrust();
      if (entry.kind !== 'memory' || entry.category !== 'Memory proposals' || !entry.id.endsWith('.json')) throw new Error('Choose a memory proposal.');
      await reviewMemory(this.binding, entry.id); await this.refresh(); return;
    }
    if (message.type === 'editEpic' || message.type === 'saveEpic') {
      requireTrust();
      if (entry.kind !== 'epic' || !entry.epic || entry.problem || !entry.epic.task) throw new Error('Choose a valid linked epic.');
      const task = await readBinding(state.root, entry.epic.task); if (!task || task.archived) throw new Error('Restore or adopt the linked task.');
      const repository = await resolveRepository(state.root, task.repository, workspacePaths()); const uri = vscode.Uri.file(repository).toString();
      const validate = async () => {
        requireTrust(); idleRepository(uri); await this.binding.validateRunTarget(uri);
        if ((await this.binding.require()).uri.fsPath !== state.root) throw new Error('Framework changed.');
        const current = await readBinding(state.root, task.note);
        if (!current || current.id !== task.id || current.archived || JSON.stringify(current.repository) !== JSON.stringify(task.repository)) throw new Error('Linked task changed.');
        if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === vscode.Uri.joinPath(root.uri, entry.id).toString() && doc.isDirty)) throw new Error('Save or discard unsaved epic source edits first.');
      };
      await validate(); const original = await readText(state.root, entry.id);
      if (hash(original) !== entry.epic.sha256) throw new Error('Epic changed. Refresh before editing.');
      if (message.type === 'editEpic') { await this.panel?.webview.postMessage({ type: 'epicDraft', id: entry.id, root: state.root, token: hash(original), content: original }); return; }
      if (message.type !== 'saveEpic') throw new Error('Invalid epic edit.');
      if (message.token !== hash(original)) throw new Error('Epic changed. Your draft was preserved; refresh before saving.');
      const taskContent = await readText(state.root, task.note);
      const content = reviewedEpic(original, message.content);
      const identity = content.match(/^- Epic-ID: ([^\r\n]+)/m)?.[1];
      if ((await dashboardEntries(state.root, workspacePaths())).some(candidate => candidate.id !== entry.id && candidate.epic?.identity === identity)) throw new Error('Duplicate Epic-ID. Resolve it before saving.');
      if (await confirmation.show('Save this reviewed epic?', { detail: 'Confirm checked steps and acceptance criteria were actually verified, each completed story received a review pass, and epic-level acceptance is verified before closing the epic. Unverified work must remain unchecked. The linked task progress pointer will be refreshed if it selects this plan or its old path is missing.' }, 'Save verified epic') !== 'Save verified epic') return;
      await applyProposal(state.root, repository, { version: 1, target: entry.id, expectedHash: message.token, content, reason: message.verification, evidence: [{ scope: 'framework', source: entry.id, sha256: message.token }] }, validate);
      const pointer = taskContent.match(/^Active plan:\s*(memory\/plans\/[^\s]+\.md).*$/m);
      const allEntries = await dashboardEntries(state.root, workspacePaths());
      const linkedPlans = allEntries.filter(candidate => candidate.epic?.task === task.note && !candidate.problem);
      if (!pointer || `.ai-os/${pointer[1]}` === entry.id || linkedPlans.length === 1 && !allEntries.some(candidate => candidate.id === `.ai-os/${pointer[1]}`)) {
        const progress = parseEpic(content); const line = `Active plan: ${entry.id.replace('.ai-os/', '')} (epic ${progress.derivedStatus}, ${progress.completed}/${progress.total} stories)`;
        const updatedTask = pointer ? taskContent.replace(pointer[0], line) : `${taskContent.trimEnd()}\n\n${line}\n`;
        if (updatedTask !== taskContent) {
          try {
            await applyProposal(state.root, repository, { version: 1, target: task.note, expectedHash: hash(taskContent), content: updatedTask, reason: `Refresh reviewed epic progress pointer: ${entry.id}`, evidence: [{ scope: 'framework', source: entry.id, sha256: hash(content) }] }, async () => {
              await validate();
              if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === vscode.Uri.joinPath(root.uri, task.note).toString() && doc.isDirty)) throw new Error('Linked task has unsaved changes.');
            });
          } catch (error) { throw new Error(`Epic saved, but its task pointer was not refreshed. Reload and save again to repair it: ${String(error)}`); }
        }
      }
      try { await this.adoptEpic?.(vscode.Uri.joinPath(root.uri, entry.id).toString(), identity!); } catch (error) { throw new Error(`Epic saved, but history identity adoption failed. Save again before moving the plan: ${String(error)}`); }
      await this.refresh(); await this.panel?.webview.postMessage({ type: 'epicSaved', id: entry.id }); return;
    }
    if (message.type === 'saveHandoff' || message.type === 'recordHandoff') {
      requireTrust();
      if (entry.kind !== 'task' || entry.archived || entry.status === 'done' || entry.problem || !entry.properties) throw new Error('Choose an open bound task.');
      if (entry.runId && this.isActive(entry.runId)) throw new Error('Finish or cancel the active run before saving its handoff.');
      const snapshot = await taskSnapshot(state.root, entry.id);
      if (message.type === 'saveHandoff') { await this.panel?.webview.postMessage({ type: 'handoffDraft', id: entry.id, root: state.root, token: snapshot.token }); return; }
      if (message.type !== 'recordHandoff') throw new Error('Invalid handoff action.');
      const content = appendHandoff(snapshot.content, { nextStep: message.nextStep, findings: message.findings, unknowns: message.unknowns, verification: message.verification }, new Date().toISOString());
      const validate = async () => {
        requireTrust(); if ((await this.binding.require()).uri.fsPath !== state.root) throw new Error('Framework changed.');
        if (this.history().some(run => this.isActive(run.id) && (run.taskId === entry.taskId || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id).toString()))) throw new Error('Finish or cancel the task run first.');
        if (vscode.workspace.textDocuments.some(doc => [entry.id, sidecar(entry.id)].some(file => doc.uri.toString() === vscode.Uri.joinPath(root.uri, file).toString()) && doc.isDirty)) throw new Error('Task has unsaved source edits.');
      };
      await editTask(state.root, entry.id, message.token, { kind: 'notes', content }, validate);
      await this.refresh(); await this.panel?.webview.postMessage({ type: 'handoffSaved', id: entry.id });
      await this.panel?.webview.postMessage({ type: 'notice', message: 'Handoff saved; task stays open. Continue with a fresh run or paste the resume prompt into a new host session.' }); return;
    }
    if (message.type === 'planEpic') {
      requireTrust();
      if (entry.kind !== 'task' || entry.archived || entry.problem || !entry.properties) throw new Error('Choose an active bound task for epic planning.');
      await vscode.env.clipboard.writeText(`Use AI-OS in ${state.root}.\nTask reference (data): ${JSON.stringify({ note: entry.id, repository: entry.repository })}\n> OS_COMMAND PLAN_WRITE\nPrepare a Type: epic rollout plan for this task with stable kebab-slug story IDs, dependencies, steps, verification and acceptance criteria. Present it for approval before execution. Keep the plan as the single source of progress and link it with the task's Active plan pointer. Native connectors should propose memory changes through the reviewed memory operation.`);
      await this.panel?.webview.postMessage({ type: 'notice', message: 'Epic planning prompt copied. Paste it into your AI-OS agent session; no plan was created.' }); return;
    }
    if (message.type === 'manageStoryRun') {
      if (entry.kind !== 'epic' || !entry.epic || entry.epic.sha256 !== message.sha256) throw new Error('Epic changed. Refresh before inspecting its runs.');
      const story = entry.epic.stories.find(story => story.id === message.storyId);
      const run = this.history().find(run => run.id === story?.run?.id && run.story && (entry.epic!.identity && run.story.epicId ? run.story.epicId === entry.epic!.identity : run.story.epicUri === vscode.Uri.joinPath(root.uri, entry.id).toString()) && run.story.id === message.storyId);
      if (!run) throw new Error('No tracked run for this story.');
      await this.showRun(run); return;
    }
    if (message.type === 'runStory') {
      requireTrust();
      if (entry.kind !== 'epic' || !entry.epic || entry.problem || entry.epic.sha256 !== message.sha256 || !entry.epic.task) throw new Error('Choose a valid linked epic.');
      const task = await readBinding(state.root, entry.epic.task);
      if (!task || task.archived || !this.runStory) throw new Error('Adopt or restore the linked task before running a story.');
      await this.runStory(task, { file: entry.id, id: message.storyId, sha256: message.sha256 }); return;
    }
    if (message.type === 'useTemplate') {
      requireTrust();
      if (entry.kind !== 'agent' || !entry.template || entry.problem) throw new Error('Choose a valid agent template.');
      await this.create('agent', entry.id); return;
    }
    if (message.type === 'select') { this.selected = entry.id; await this.preview(entry.id); return; }
    if (entry.kind === 'run' || entry.kind === 'repository') {
      if (message.type !== 'open') throw new Error('Unsupported action for this page.');
      if (entry.kind === 'run') {
        const run = this.history().find(run => entry.id === 'run:' + run.id);
        if (!run) throw new Error('Run no longer exists.');
        await this.showRun(run);
      } else {
        const target = JSON.parse(entry.id.slice('repository:'.length));
        await vscode.commands.executeCommand('revealInExplorer', vscode.Uri.file(await resolveRepository(state.root, target, workspacePaths())));
      }
      return;
    }
    if (message.type === 'manageTaskRun') {
      const run = this.history().find(run => run.id === entry.runId && ((entry.taskId && run.taskId === entry.taskId) || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id).toString() || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id.replace('/archived_tasks/', '/tasks/')).toString()));
      if (entry.kind !== 'task' || !run) throw new Error('No linked run is available.');
      await this.showRun(run); return;
    }
    if (message.type === 'editTask') {
      requireTrust();
      if (entry.kind !== 'task') throw new Error('Choose a task to edit.');
      await this.sendDraft(entry.id, state.root); return;
    }
    if (message.type === 'saveNotes' || message.type === 'saveProperties' || message.type === 'archiveTask') {
      requireTrust();
      if (entry.kind !== 'task') throw new Error('Choose a task to edit.');
      if (entry.archived && message.type !== 'archiveTask') throw new Error('Restore the task before editing it.');
      if (message.type === 'archiveTask' && entry.runId && this.isActive(entry.runId)) throw new Error('Cancel or finish this task run before closing, archiving or restoring it.');
      if (message.type === 'archiveTask' && message.archived && await confirmation.show('Archive this task in the dashboard? Notes and links remain intact. This does not run TASK_CLOSE or save session continuity.', {}, 'Archive') !== 'Archive') return;
      const validate = async (transientFiles: string[] = []) => {
        requireTrust();
        if (((message.type === 'saveProperties' && message.status === 'done') || message.type === 'archiveTask') && this.history().some(run => this.isActive(run.id) && ((entry.taskId && run.taskId === entry.taskId) || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id).toString()))) throw new Error('Cancel or finish this task run before closing, archiving or restoring it.');
        if ((await this.binding.require()).uri.fsPath !== state.root) throw new Error('Framework changed. Reload the task.');
        if (message.type === 'saveProperties' && message.status === 'done' && entry.status !== 'done') {
          const latest = this.history().find(run => (entry.taskId && run.taskId === entry.taskId) || run.taskUri === vscode.Uri.joinPath(root.uri, entry.id).toString());
          if (latest) {
            await this.binding.validateRunTarget(latest.repositoryUri);
            const repository = vscode.Uri.parse(latest.repositoryUri).fsPath;
            const transient = transientFiles.map(file => vscode.Uri.joinPath(root.uri, file).fsPath).filter(file => inside(repository, file)).map(file => path.relative(repository, file).split(path.sep).join('/'));
            if (!latest.review || (await repositoryReview(repository, transient)).token !== latest.review.repositoryToken) throw new Error('Review and accept the current repository changes before marking this task done.');
          }
          const currentEntries = await dashboardEntries(state.root, workspacePaths());
          const currentTask = currentEntries.find(candidate => candidate.id === entry.id);
          if (!currentTask || currentTask.problem || currentTask.archived) throw new Error('Task authorization changed.');
          const plan = currentEntries.find(candidate => candidate.id === currentTask.plan);
          if (currentTask.plan && !plan) throw new Error('Resolve the missing active plan before completing the task.');
          if (plan?.kind === 'epic' && (plan.problem || !plan.epic || plan.epic.derivedStatus !== 'done')) throw new Error('Complete and verify the linked epic before marking this task done.');
        }
        const uris = [entry.id, sidecar(entry.id)].map(file => vscode.Uri.joinPath(root.uri, file).toString());
        if (vscode.workspace.textDocuments.some(document => uris.includes(document.uri.toString()) && document.isDirty)) throw new Error('Task notes or properties have unsaved editor changes. Save or discard them in VS Code before using this form.');
      };
      await validate();
      if (message.type === 'saveProperties' && message.status === 'done' && entry.status !== 'done') {
        if (await confirmation.show('Mark the task done?', { detail: 'Confirm the requested work and acceptance criteria were verified and reviewed. Run success alone is insufficient. This state change does not run TASK_CLOSE or promote memory.' }, 'Mark verified task done') !== 'Mark verified task done') return;
      }
      const edit: TaskEdit = message.type === 'saveNotes' ? { kind: 'notes', content: message.content }
        : message.type === 'saveProperties' ? { kind: 'properties', title: message.title, status: message.status, agentId: message.agentId }
        : { kind: 'archive', archived: message.archived };
      if (entry.id.startsWith('.ai-os/memory/archived_tasks/')) {
        if (message.type !== 'archiveTask' || message.archived) throw new Error('Physically archived tasks are read-only. Restore the task first.');
        await validate(); const snapshot = await taskSnapshot(state.root, entry.id);
        if (snapshot.token !== message.token) throw new Error('Task changed on disk. Reload before restoring.');
        await promisify(execFile)(process.platform === 'win32' ? 'python' : 'python3', ['-I', '-B', vscode.Uri.joinPath(this.extensionUri, 'dist/runtime/archive_task.py').fsPath, '--root', state.root, '--note', entry.id, '--restore', '--expected-hash', hash(snapshot.content)], { windowsHide: true, timeout: 10000, maxBuffer: 65536 });
        await this.refresh(); await this.sendDraft(entry.id.replace('/archived_tasks/', '/tasks/'), state.root, message.type);
        await this.panel?.webview.postMessage({ type: 'notice', message: 'Task and metadata restored together.' }); return;
      }
      await editTask(state.root, entry.id, message.token, edit, validate);
      await this.refresh();
      await this.sendDraft(entry.id, state.root, message.type);
      await this.panel?.webview.postMessage({ type: 'notice', message: message.type === 'archiveTask' ? (message.archived ? 'Task archived in the dashboard. Notes and links are preserved.' : 'Task restored.') : 'Task saved.' });
      return;
    }
    if (message.type === 'park' || message.type === 'resume') {
      requireTrust();
      const current = (await dashboardEntries(state.root, workspacePaths())).find(item => item.id === entry.id);
      const identity = (value: typeof entry | undefined) => value && JSON.stringify([value.id, value.title, value.status, value.repository, value.properties, value.problem, value.archived, value.agentId]);
      if (identity(current) !== identity(entry)) throw new Error('Task binding changed. Refresh before preparing a handoff.');
      if (entry.problem) throw new Error('Resolve the task binding problem before preparing a handoff.');
      await vscode.env.clipboard.writeText(handoffPrompt(entry, state.root, message.type));
      await this.panel?.webview.postMessage({ type: 'notice', message: 'Prompt copied. Run it in your agent session; no task state or conversation context was changed.' }); return;
    }
    if (message.type === 'properties' && !entry.properties) throw new Error('This task has no properties. Adopt it first.');
    const file = message.type === 'properties' ? entry.properties! : entry.id;
    await this.files.open(new Item(entry.title, root, file, entry.kind === 'memory'));
  }
}
