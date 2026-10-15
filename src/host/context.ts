import * as vscode from 'vscode';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { WorkspaceBinding, requireTrust, workspacePaths } from './binding';
import { pickRepository, pickTask } from './workspace';
import { readBinding, TaskBinding } from '../framework/tasks';
import { RepositoryTarget, resolveRepository } from '../framework/workspace';
import { ContextPack, previewContext } from '../framework/runtime';
import { safePath } from '../core/files';

export class ContextPreviews implements vscode.Disposable {
  private documents = new Map<string, string>();
  private subscriptions: vscode.Disposable[];
  constructor(private binding: WorkspaceBinding, readonly extensionUri: vscode.Uri) {
    this.subscriptions = [
      vscode.workspace.registerTextDocumentContentProvider('ai-os-context', { provideTextDocumentContent: uri => {
        const content = this.documents.get(uri.toString());
        if (content === undefined) throw new Error('Preview expired. Generate a new task context preview.');
        return content;
      } }),
      vscode.workspace.onDidCloseTextDocument(doc => { this.documents.delete(doc.uri.toString()); }),
    ];
  }
  dispose() { this.subscriptions.forEach(item => item.dispose()); this.documents.clear(); }
  async build(task: TaskBinding | null, repository: string | RepositoryTarget, files: string[]): Promise<ContextPack> {
    requireTrust();
    const root = await this.binding.require();
    const directory = await resolveRepository(root.uri.fsPath, repository, workspacePaths());
    for (const file of files) await safePath(directory, file);
    const validate = async () => {
      requireTrust();
      if ((await this.binding.require()).uri.toString() !== root.uri.toString()
        || await resolveRepository(root.uri.fsPath, repository, workspacePaths()) !== directory) throw new Error('Workspace binding changed. Generate a new preview.');
      if (task && JSON.stringify(await readBinding(root.uri.fsPath, task.note)) !== JSON.stringify(task)) throw new Error('Task binding changed. Generate a new preview.');
      if (task && await resolveRepository(root.uri.fsPath, task.repository, workspacePaths()) !== directory) throw new Error('Repository does not match the selected task.');
    };
    await validate();
    const pack = await previewContext(vscode.Uri.joinPath(this.extensionUri, 'dist/runtime/runtime.py').fsPath, {
      frameworkRoot: root.uri.fsPath, repositoryRoot: directory, task: task?.note ?? null, files,
    });
    await validate();
    return pack;
  }
  async open(pack: ContextPack): Promise<void> {
    const uri = vscode.Uri.from({ scheme: 'ai-os-context', path: `/${randomUUID()}/task-context.json` });
    this.documents.set(uri.toString(), JSON.stringify(pack, null, 2) + '\n');
    try { await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri), { preview: true }); }
    catch (error) { this.documents.delete(uri.toString()); throw error; }
  }
  async show(): Promise<void> {
    requireTrust();
    const root = await this.binding.require();
    const task = await pickTask(root);
    if (task === undefined) return;
    const repository = task?.repository ?? await pickRepository();
    if (!repository) return;
    const directory = await resolveRepository(root.uri.fsPath, repository, workspacePaths());
    const choice = await vscode.window.showQuickPick(['Task and plan only', 'Include repository files…'], { title: 'Preview context locally' });
    if (!choice) return;
    let files: string[] = [];
    if (choice === 'Include repository files…') {
      const selected = await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.file(directory), canSelectFiles: true, canSelectFolders: false, canSelectMany: true, openLabel: 'Include in preview' });
      if (!selected) return;
      if (selected.some(uri => uri.scheme !== 'file')) throw new Error('Select local repository files.');
      files = selected.map(uri => path.relative(directory, uri.fsPath).split(path.sep).join('/'));
    }
    if ((await this.binding.require()).uri.toString() !== root.uri.toString()) throw new Error('Shared framework changed. Start again.');
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Building task context preview' }, async () => {
      await this.open(await this.build(task, repository, files));
    });
  }
}
