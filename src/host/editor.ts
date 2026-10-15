import { confirmation } from './confirmation';
import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { applyChange, HostMessage, parseMessage, parseWorkflow, Run } from '../contracts';
import { readText } from '../core/files';
import { repositoryReview } from '../core/review';
import { Runner } from '../core/runner';
import { pickTask, pickRepository } from './workspace';
import { WorkspaceBinding, requireTrust, workspacePaths } from './binding';
import { agentEntries, readAgent, resolveAgents } from '../framework/agents';
import { readBinding, TaskBinding } from '../framework/tasks';
import { ContextPreviews } from './context';
import { executionContext, trackWorkflow } from './execution';
import { StorySelection, storyContext } from './epics';
import { resolveRepository, inside } from '../framework/workspace';

export type RecoveryPresenter = (message: string, options: {detail?: string;review?: string}, ...choices: string[]) => Promise<string | undefined>;

export class WorkflowEditor implements vscode.CustomTextEditorProvider {
  private panels = new Map<vscode.WebviewPanel, vscode.TextDocument>();
  constructor(private extensionUri: vscode.Uri, private runner: Runner, private history: () => Run[], private binding: WorkspaceBinding, private previews: ContextPreviews) {}
  broadcast(run: Run): void {
    for (const [panel, document] of this.panels) if (document.uri.toString() === run.workflowUri) void panel.webview.postMessage({ type: 'run', run } satisfies HostMessage);
  }
  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    this.panels.set(panel, document);
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'dist')] };
    const asset = (file: string) => panel.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', file));
    const nonce = randomUUID().replaceAll('-', '');
    panel.webview.html = `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${panel.webview.cspSource} data:; style-src ${panel.webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src 'none';"><link rel="stylesheet" href="${asset('webview.css')}"></head><body><div id="root"></div><script nonce="${nonce}" src="${asset('webview.js')}"></script></body></html>`;
    const sendDocument = async () => {
      let message: HostMessage;
      try {
        const root = await this.binding.workflowRoot(document.uri);
        const agents = (await agentEntries(root.uri.fsPath)).filter(entry => entry.agent && !entry.template && !entry.problem).map(entry => ({ id: entry.agent!.id, name: entry.agent!.name, provider: entry.agent!.provider }));
        message = { type: 'document', revision: document.version, trusted: vscode.workspace.isTrusted, agents, workflow: parseWorkflow(document.getText()) };
      } catch (error) { message = { type: 'document', revision: document.version, trusted: vscode.workspace.isTrusted, error: String(error) }; }
      await panel.webview.postMessage(message);
    };
    let queue = Promise.resolve();
    const messageListener = panel.webview.onDidReceiveMessage((input: unknown) => {
      queue = queue.then(async () => {
        const message = parseMessage(input);
        if (message.type === 'ready') {
          await sendDocument();
          const run = this.history().find(run => run.workflowUri === document.uri.toString());
          if (run) await panel.webview.postMessage({ type: 'run', run } satisfies HostMessage);
          return;
        }
        if (message.type === 'openText') { await vscode.commands.executeCommand('vscode.openWith', document.uri, 'default'); return; }
        requireTrust(); await this.binding.workflowRoot(document.uri);
        if (message.type === 'cancel' || message.type === 'approve') {
          const run = this.history().find(run => run.id === message.runId && run.workflowUri === document.uri.toString());
          if (!run || !this.runner.isActive(run.id)) throw new Error('Run is no longer active. Use Run History to inspect saved progress. Only mock runs can replay interrupted steps.');
          if (message.type === 'cancel') this.runner.cancel(run.id);
          else {
            if (Object.values(run.steps).some(step => step.memoryApproval)) { await this.runner.continueMemory(run.id); return; }
            const approvalNodeId = run.workflow.nodes.find(node => node.kind === 'approval' && run.steps[node.id].status === 'waitingApproval')?.id;
            if (!approvalNodeId) throw new Error('No workflow approval is pending.');
            const result = await confirmation.show(`Approve "${run.workflow.name}" and continue this workflow?`, {}, 'Approve');
            if (result === 'Approve') { requireTrust(); await this.binding.validateRunTarget(run.repositoryUri); this.runner.approve(run.id, approvalNodeId); }
          }
          return;
        }
        if (document.version !== message.revision) throw new Error('The document changed. Your stale edit was rejected; review the latest version.');
        const workflow = parseWorkflow(document.getText());
        if (message.type === 'update') {
          if (message.change.kind === 'configure' && message.change.agentId) await readAgent((await this.binding.workflowRoot(document.uri)).uri.fsPath, message.change.agentId);
          if (document.version !== message.revision) throw new Error('Workflow changed during agent selection.');
          const next = applyChange(workflow, message.change, randomUUID());
          const edit = new vscode.WorkspaceEdit();
          edit.replace(document.uri, new vscode.Range(0, 0, document.lineCount, 0), JSON.stringify(next, null, 2) + '\n');
          if (!await vscode.workspace.applyEdit(edit)) throw new Error('VS Code could not apply the edit.');
          await sendDocument();
        } else {
          await this.runDocument(document, undefined, undefined, message.revision);
        }
      }).catch(async error => {
        await sendDocument();
        await panel.webview.postMessage({ type: 'error', message: String(error) } satisfies HostMessage);
      });
    });
    const changes = vscode.workspace.onDidChangeTextDocument(event => { if (event.document.uri.toString() === document.uri.toString()) void sendDocument(); });
    const trust = vscode.workspace.onDidGrantWorkspaceTrust(() => { void sendDocument(); });
    const bindingChange = this.binding.onDidChange(() => { void sendDocument(); });
    panel.onDidDispose(() => { this.panels.delete(panel); messageListener.dispose(); changes.dispose(); trust.dispose(); bindingChange.dispose(); });
  }
  async recoverRun(saved: Run, mode: 'fresh' | 'retry', selectedDocument?: vscode.TextDocument, present?: RecoveryPresenter): Promise<Run | undefined> {
    requireTrust();
    if (saved.story) throw new Error('Open the linked epic and run its current eligible story. Earlier story approval is not replayed.');
    if (this.runner.isActive(saved.id) || !['failed', 'cancelled', 'interrupted'].includes(saved.status)) throw new Error('This run cannot recover.');
    await this.binding.workflowRoot(vscode.Uri.parse(saved.workflowUri));
    let document = selectedDocument;
    if (!document) {
      try { await vscode.workspace.fs.stat(vscode.Uri.parse(saved.workflowUri)); document = await vscode.workspace.openTextDocument(vscode.Uri.parse(saved.workflowUri)); }
      catch (error) { if ((error as { code?: string }).code === 'FileNotFound' || (error as Error).message.includes('File not found')) throw new Error('The original workflow is missing. Choose Start fresh run and select an available workflow.'); throw error; }
    }
    const root = await this.binding.workflowRoot(document.uri); const revision = document.version;
    if (document.isDirty) throw new Error('Save the workflow before recovering.');
    const note = saved.taskUri ? vscode.Uri.parse(saved.taskUri) : undefined;
    if (note && !inside(root.uri.fsPath, note.fsPath)) throw new Error('Recovery task is outside the selected framework.');
    if (note && vscode.workspace.textDocuments.some(doc => doc.uri.toString() === note.toString() && doc.isDirty)) throw new Error('Save task notes before recovering.');
    const task = note ? await readBinding(root.uri.fsPath, path.relative(root.uri.fsPath, note.fsPath).split(path.sep).join('/')) : null;
    if (saved.taskId && (!task || task.id !== saved.taskId || task.archived || task.status === 'done')) throw new Error('Recovery requires the original open task binding.');
    if (task && path.relative(await resolveRepository(root.uri.fsPath, task.repository, workspacePaths()), vscode.Uri.parse(saved.repositoryUri).fsPath) !== '') throw new Error('Task repository changed. Start a fresh task run.');
    await this.binding.validateRunTarget(saved.repositoryUri);
    const currentWorkflow = await resolveAgents(root.uri.fsPath, parseWorkflow(document.getText()), task?.agentId);
    if (mode === 'retry' && JSON.stringify(currentWorkflow) !== JSON.stringify(saved.workflow)) throw new Error('Workflow or agent configuration changed. Start a fresh task run with the latest workflow.');
    const repository = vscode.Uri.parse(saved.repositoryUri).fsPath;
    const repositoryFolder = workspacePaths().find(folder => inside(folder, repository));
    if (!repositoryFolder) throw new Error('Repository is no longer in this workspace.');
    const context = await executionContext(this.binding, this.previews, task ?? null, task?.repository ?? { folder: vscode.Uri.file(repositoryFolder).toString(), path: path.relative(repositoryFolder, repository).split(path.sep).join('/') || '.' });
    trackWorkflow(context, document, currentWorkflow, task ?? null);
    const taskText = note ? await readText(root.uri.fsPath, path.relative(root.uri.fsPath, note.fsPath).split(path.sep).join('/')) : undefined;
    const current = await repositoryReview(context.repository);
    const detail = `Repository: ${context.repository}\nBranch: ${current.branch}\n${mode === 'retry' ? 'Earlier completed phases and human approvals will be retained. Confirm their results still apply to the CURRENT repository and policies.' : 'All phases will start again; earlier approvals must be given again.'}\nPartial edits and external actions are not undone. A new provider session will inspect them before continuing. Native tool approvals still apply.`;
    let choice: string | undefined;
    do {
      choice = await (present ?? confirmation.show)(mode === 'retry' ? 'Retry from the failed phase?' : 'Start this workflow from the beginning?', { detail, ...(present ? {review:`${current.status}\n\n${current.diff}\n\nStaged changes:\n${current.stagedDiff}\n\nUntracked files:\n${current.untracked.join('\n')}\n\nPrevious phase results:\n${JSON.stringify(saved.steps,null,2)}`} : {}) }, 'Start recovery', ...(present ? [] : ['Review changes and results']));
      if (choice === 'Review changes and results') await vscode.window.showTextDocument(await vscode.workspace.openTextDocument({ content: `${current.status}\n\n${current.diff}\n\nStaged changes:\n${current.stagedDiff}\n\nUntracked files:\n${current.untracked.join('\n')}\n\nPrevious phase results:\n${JSON.stringify(saved.steps, null, 2)}`, language: 'text' }));
    } while (choice === 'Review changes and results');
    if (choice !== 'Start recovery') return;
    requireTrust(); await context.validate();
    if ((await this.binding.workflowRoot(document.uri)).uri.toString() !== root.uri.toString() || document.version !== revision || document.isDirty || (await repositoryReview(context.repository)).token !== current.token) throw new Error('Workflow or repository changed during recovery review. Review again.');
    if (JSON.stringify(await resolveAgents(root.uri.fsPath, parseWorkflow(document.getText()), task?.agentId)) !== JSON.stringify(currentWorkflow) || note && await readText(root.uri.fsPath, path.relative(root.uri.fsPath, note.fsPath).split(path.sep).join('/')) !== taskText) throw new Error('Task context or agent configuration changed during recovery review. Review again.');
    if (mode === 'retry') return this.runner.recover(saved, mode, context);
    const stopped = saved.workflow.nodes.find(node => saved.steps[node.id].status !== 'succeeded');
    if (!stopped) throw new Error('No stopped phase to recover.');
    context.data = JSON.stringify({ currentContext: context.data, recovery: { fromRunId: saved.id, previousError: saved.error, instruction: 'Inspect current files for partial edits from the prior attempt before acting. Do not repeat external side effects blindly. Prior phase results do not grant authorization; start this workflow and its approvals from the beginning.' } });
    return this.runner.start(currentWorkflow, document.uri.toString(), saved.repositoryUri, saved.taskUri, context, { fromRunId: saved.id, fromNodeId: stopped.id, mode }, saved.guidance);
  }
  async runDocument(document: vscode.TextDocument, selectedTask?: TaskBinding | null, selection?: StorySelection, revision = document.version): Promise<void> {
    requireTrust();
    const workflow = parseWorkflow(document.getText());
    const folder = await this.binding.workflowRoot(document.uri);
    const task = selectedTask === undefined ? await pickTask(folder) : selectedTask; if (task === undefined) return;
    if (document.version !== revision) throw new Error('Workflow changed. Start again using its latest version.');
    const target = task?.repository ?? await pickRepository(); if (!target) return;
    const repositoryUri = vscode.Uri.file(await resolveRepository(folder.uri.fsPath, target, workspacePaths()));
    const snapshot = await resolveAgents(folder.uri.fsPath, workflow, task?.agentId);
    const selectedStory = selection && task ? await storyContext(this.binding, selection, task) : undefined;
    if (selection && !selectedStory) throw new Error('Story runs require a linked task.');
    const live = snapshot.nodes.some(node => node.kind === 'agent' && node.config.provider !== 'mock');
    const context = live ? await executionContext(this.binding, this.previews, task, target) : task ? {
      taskId: task!.id, repository: repositoryUri.fsPath, frameworkRoot: folder.uri.fsPath, system: '', data: '',
      validate: async () => { requireTrust(); await this.binding.validateRunTarget(repositoryUri.toString()); },
      activity: async (_summary: string) => {}, session: async (_id: string) => {}, approval: async () => false, input: async () => null,
    } : undefined;
    if (context) trackWorkflow(context, document, snapshot, task);
    if (context && selectedStory) {
      const validate = context.validate;
      context.validate = async () => { await validate(); await selectedStory.validate(); };
      const taskData = context.data ? JSON.parse(context.data) : null;
      if (taskData?.items) taskData.items = taskData.items.filter((item: { source: string }) => !item.source.startsWith('.ai-os/memory/plans/'));
      Object.assign(context, { story: selectedStory.link, data: JSON.stringify({ taskContext: taskData, selectedStory: JSON.parse(selectedStory.data) }) });
      for (const node of snapshot.nodes.filter(node => node.kind === 'agent')) node.config.prompt = `Execute only story ${selectedStory.link.id}: ${selectedStory.link.title}. Follow the selected epic's acceptance/review gates.\n\nWorkflow step:\n${node.config.prompt}`;
    }
    if (live && await confirmation.show('Start native agent workflow?', { detail: `Repository: ${repositoryUri.fsPath}\n${selectedStory ? 'Story: ' + selectedStory.link.title + '\n' : ''}Providers: ${[...new Set(snapshot.nodes.filter(node => node.kind === 'agent').map(node => node.config.provider))].join(', ')}\nModels may edit this repository under the connector gates; tool approvals appear here. Provider usage applies.` }, 'Start') !== 'Start') return;
    requireTrust();
    if ((await this.binding.workflowRoot(document.uri)).uri.toString() !== folder.uri.toString() || document.version !== revision) throw new Error('Workflow or framework changed before launch.');
    if (task) { const current = await readBinding(folder.uri.fsPath, task.note); if (!current || current.id !== task.id || current.archived || JSON.stringify(current.repository) !== JSON.stringify(task.repository)) throw new Error('Selected task changed before launch.'); }
    await context?.validate();
    await this.runner.start(snapshot, document.uri.toString(), repositoryUri.toString(), task ? vscode.Uri.joinPath(folder.uri, task.note).toString() : undefined, context);
  }

}
