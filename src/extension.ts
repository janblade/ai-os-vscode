import { finishRun } from './host/finish-run';
import { confirmation } from './host/confirmation';
import * as vscode from 'vscode';
import path from 'node:path';
import { reviewMemory } from './host/memory';
import { Run } from './contracts';
import { Runner, RunStore } from './core/runner';
import { ProviderRouter } from './providers/router';
import { WorkflowEditor, RecoveryPresenter } from './host/editor';
import { WorkspaceFiles, adoptExistingTask, newWorkflow } from './host/workspace';
import { WorkspaceBinding, requireTrust, workspacePaths } from './host/binding';
import { inside } from './framework/workspace';
import { readText } from './core/files';
import { ContextPreviews } from './host/context';
import { WorkspaceNavigation } from './host/navigation';
import { dashboardEntries } from './framework/dashboard';
import { Dashboard } from './host/dashboard';

let runner: Runner | undefined;
export async function activate(context: vscode.ExtensionContext) {
  const history = new Map<string, Run>();
  const output = vscode.window.createOutputChannel('AI OS');
  const binding = new WorkspaceBinding(context);
  const previews = new ContextPreviews(binding, context.extensionUri);
  const report = (error: unknown) => { output.appendLine(String(error)); void vscode.window.showErrorMessage(`AI OS: ${String(error)}`); };
  const store = new RunStore(vscode.Uri.joinPath(context.storageUri ?? context.globalStorageUri, 'runs').fsPath);
  const sorted = () => [...history.values()].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt) || Date.parse(b.createdAt) - Date.parse(a.createdAt));
  let editor: WorkflowEditor; let dashboard: Dashboard;
  runner = new Runner(store, new ProviderRouter(vscode.Uri.joinPath(context.extensionUri, 'dist/claude-worker.mjs').fsPath), run => { history.set(run.id, run); dashboard?.updateRun(run); editor?.broadcast(run); }, report, vscode.Uri.joinPath(context.globalStorageUri, 'repository-locks').fsPath);
  editor = new WorkflowEditor(context.extensionUri, runner, sorted, binding, previews);
  const approveRun = async (run: Run) => {
    requireTrust(); await binding.workflowRoot(vscode.Uri.parse(run.workflowUri)); await binding.validateRunTarget(run.repositoryUri);
    const current = history.get(run.id);
    if (!current || !runner!.isActive(run.id) || current.status !== 'waitingApproval' || Object.values(current.steps).some(step => step.toolApproval)) throw new Error('No workflow approval is pending.');
    if (Object.values(current.steps).some(step => step.memoryApproval)) { await runner!.continueMemory(run.id); return; }
    const index = current.workflow.nodes.findIndex(node => node.kind === 'approval' && current.steps[node.id].status === 'waitingApproval');
    const approvalNodeId = current.workflow.nodes[index]?.id;
    if (!approvalNodeId) throw new Error('No workflow approval is pending.');
    const next = current.workflow.nodes[index + 1];
    if (await confirmation.show(next ? `Approve the result and start ${next.label}?` : 'Approve this workflow result?', { detail: `Repository: ${vscode.Uri.parse(run.repositoryUri).fsPath}\n\nReview the preceding phase output and verification. This workflow approval does not accept durable memory or mark a task complete.\n\n${current.workflow.nodes.slice(0, index).map(node => `${node.label}\n${current.steps[node.id].output ?? ''}`).join('\n\n')}` }, 'Approve') !== 'Approve') return;
    requireTrust(); await binding.validateRunTarget(run.repositoryUri); await runner!.revalidate(); runner!.approve(run.id, approvalNodeId);
  };
  const showRun = async (run: Run) => {
    const active = runner!.isActive(run.id);
    const approvalAction = Object.values(run.steps).some(step => step.memoryApproval) ? 'Continue after memory approval' : 'Approve';
    const options = active ? ['Show snapshot', 'Open workflow', ...(run.status === 'waitingApproval' && !Object.values(run.steps).some(step => step.toolApproval) ? [approvalAction] : []), 'Cancel run'] : ['Show snapshot', 'Open workflow', ...(!run.story && ['interrupted', 'waitingApproval'].includes(run.status) && run.workflow.nodes.every(node => node.kind !== 'agent' || node.config.provider === 'mock') ? ['Resume mock run'] : [])];
    const action = await vscode.window.showQuickPick(options, { title: `${run.workflow.name} · ${run.status}` });
    if (action === 'Show snapshot') {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(vscode.Uri.from({ scheme: 'ai-os-run', path: `/${run.id}.json` })));
    }
    if (action === 'Open workflow') { await binding.workflowRoot(vscode.Uri.parse(run.workflowUri)); await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.parse(run.workflowUri), 'aiOs.workflow'); }
    if (action === 'Cancel run') { runner!.cancel(run.id); return; }
    if (['Resume mock run', approvalAction].includes(action ?? '')) {
      requireTrust(); await binding.workflowRoot(vscode.Uri.parse(run.workflowUri));
      if (action === approvalAction) await approveRun(run);
      if (action === 'Resume mock run' && await confirmation.show('Resume the saved workflow snapshot? Incomplete mock steps will run again.', {}, 'Resume') === 'Resume') { requireTrust(); await binding.validateRunTarget(run.repositoryUri); await runner!.resume(history.get(run.id)!); }
    }
  };
  const files = new WorkspaceFiles(binding, showRun);
  dashboard = new Dashboard(binding, context.extensionUri, files, sorted, showRun, id => runner!.isActive(id), previews, async (task, selection) => {
    const root = await binding.require();
    const workflows = (await dashboardEntries(root.uri.fsPath, workspacePaths())).filter(entry => entry.kind === 'workflow' && entry.id.endsWith('.workflow.json'));
    if (!workflows.length) { await dashboard.show('workflow'); await vscode.window.showInformationMessage('Create a workflow before running a task or epic story.'); return; }
    const selected = await vscode.window.showQuickPick(workflows.map(entry => ({ label: entry.title, file: entry.id })), { title: selection ? 'Choose a reusable workflow for this story' : 'Choose a reusable workflow for this task' });
    if (!selected) return;
    if ((await binding.require()).uri.toString() !== root.uri.toString()) throw new Error('Framework changed.');
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, selected.file));
    await editor.runDocument(document, task, selection);
  }, async (run, review) => runner!.recordReview(run, review), async (uri, identity) => {
    for (const run of sorted()) if (run.story?.epicUri === uri && !run.story.epicId) await runner!.adoptEpicIdentity(run, uri, identity);
  }, (run, present) => recoverRun(run, present), (run, mode, reason, nodes) => finishRun(runner!, binding, previews, sorted, run, mode, reason, nodes));
  const recoverRun = async (requested: Run, present?: RecoveryPresenter): Promise<Run | undefined> => {
      const id = requested.id; requireTrust(); const run = history.get(id); if (!run || runner!.isActive(id)) throw new Error('No stopped run to recover.');
      if (run.finalization) throw new Error('Use Finish early to request a new wrap-up or closure with current context.');
      if (run.story) { await binding.workflowRoot(vscode.Uri.parse(run.workflowUri)); await binding.validateRunTarget(run.repositoryUri); await dashboard.show('epic'); await vscode.window.showInformationMessage('Select the linked epic and run its current eligible story. Story dependencies and approvals are checked again.'); return; }
      const option = await (present ?? confirmation.show)('Recover run', { detail: `Workflow: ${run.workflow.name}\nRepository: ${vscode.Uri.parse(run.repositoryUri).fsPath}\n\nChoose a recovery mode, then review and select Start recovery. Retry from failed phase keeps completed phases and earlier workflow approvals. Start fresh run selects a workflow and resets all phases and approvals. Review partial changes first; both choices start a new provider session and retain existing edits.` }, ...(!Object.values(run.steps).some(step=>step.skipReason)?['Retry from failed phase']:[]), 'Start fresh run');
      if (!option) return;
      let document: vscode.TextDocument | undefined;
      if (option === 'Start fresh run') {
        const root = await binding.workflowRoot(vscode.Uri.parse(run.workflowUri));
        const workflows = (await dashboardEntries(root.uri.fsPath, workspacePaths())).filter(entry => entry.kind === 'workflow' && entry.id.endsWith('.workflow.json'));
        if (!workflows.length) throw new Error('Create or restore a workflow before starting a fresh run.');
        const selected = await (present ?? confirmation.show)('Choose workflow for fresh recovery', { detail: 'Select an available workflow. All phases and approvals start again; partial edits remain.' }, ...workflows.map(entry => entry.id));
        if (!selected) return;
        if (!workflows.some(entry => entry.id === selected)) throw new Error('Workflow selection is no longer available.');
        document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root.uri, selected));
      }
      return editor.recoverRun(history.get(id)!, option === 'Retry from failed phase' ? 'retry' : 'fresh', document, present);

  };
  const navigation = new WorkspaceNavigation(dashboard);
  try { for (const run of await store.recover()) history.set(run.id, run); } catch (error) { report(error); }
  for (const problem of store.problems) report(`Skipped invalid run snapshot: ${problem}`);
  const command = (name: string, action: (...args: any[]) => unknown) => vscode.commands.registerCommand(name, async (...args: unknown[]) => { try { return await action(...args); } catch (error) { report(error); } });
  const refresh = async () => { await runner!.revalidate(); await binding.current(); await dashboard.refresh(); };
  context.subscriptions.push(output, binding, previews, dashboard,
    vscode.window.registerWebviewViewProvider('aiOs.workspace', navigation),
    binding.onDidChange(() => { void refresh().catch(report); }),
    vscode.workspace.onDidSaveTextDocument(() => { void refresh().catch(report); }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => { void refresh().catch(report); }),
    vscode.window.registerCustomEditorProvider('aiOs.workflow', editor, { supportsMultipleEditorsPerDocument: true }),
    command('aiOs.selectFramework', () => binding.select()), command('aiOs.initialize', () => binding.initialize()),
    vscode.commands.registerCommand('aiOs.recoverRun', async (id: string) => { const run=history.get(id); if (!run) throw new Error('Run no longer exists.'); return recoverRun(run); }),
    command('aiOs.approveRun', (id: string) => { const run = history.get(id); if (!run) throw new Error('Run no longer exists.'); return approveRun(run); }),
    command('aiOs.reviewMemory', () => reviewMemory(binding)),
    command('aiOs.previewContext', () => previews.show()),
    command('aiOs.openDashboard', () => dashboard.show()),
    command('aiOs.createAgent', () => dashboard.create('agent')),
    command('aiOs.createTask', () => dashboard.create('task')), command('aiOs.adoptTask', () => adoptExistingTask(binding)), command('aiOs.createWorkflow', () => newWorkflow(binding)),
    command('aiOs.refresh', refresh), command('aiOs.openItem', item => files.open(item)),
    command('aiOs.showRuns', async () => { const item = await vscode.window.showQuickPick(sorted().map(run => ({ label: `${run.workflow.name} · ${run.status}`, description: run.createdAt, run })), { title: 'AI OS run history' }); if (item) await showRun(item.run); }),
    vscode.workspace.registerTextDocumentContentProvider('ai-os-run', { provideTextDocumentContent: uri => {
      const id = path.posix.basename(uri.path, '.json'); const run = history.get(id);
      if (!run) throw new Error('Run no longer exists.'); return JSON.stringify(run, null, 2);
    } }),
    vscode.workspace.registerTextDocumentContentProvider('ai-os-readonly', { provideTextDocumentContent: async uri => {
      const original = uri.with({ scheme: 'file' });
      const shared = await binding.current();
      const folder = [...workspacePaths(), ...(shared ? [shared.uri.fsPath] : [])].find(root => inside(root, original.fsPath));
      if (!folder) throw new Error('File is outside the workspace and its selected AI OS location.');
      return readText(folder, path.relative(folder, original.fsPath).split(path.sep).join('/'));
    } }),
  );
  // VS Code integration tests exercise the same editor and runner as the commands.
  await refresh();
  return { confirmation, editor, runner, files, navigation, binding, previews, dashboard, history: sorted };
}
export async function deactivate() { await runner?.stop(); }
