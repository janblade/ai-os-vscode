import * as vscode from 'vscode';
import path from 'node:path';
import { realpath, readFile } from 'node:fs/promises';
import { discoverFrameworks, inspectFramework, inside, resolveRepository } from '../framework/workspace';
import { initializeFramework, FrameworkPayload } from '../framework/install';
import { safePath } from '../core/files';

export interface FrameworkRoot { uri: vscode.Uri; name: string }
export function requireTrust(): void {
  if (!vscode.workspace.isTrusted) throw new Error('Trust this workspace before creating, editing, or running AI OS workflows.');
}
export function workspacePaths(): string[] {
  return (vscode.workspace.workspaceFolders ?? []).filter(folder => folder.uri.scheme === 'file').map(folder => folder.uri.fsPath);
}
export class WorkspaceBinding implements vscode.Disposable {
  private changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private watcher?: vscode.FileSystemWatcher;
  private watched?: string;
  problem = '';
  constructor(private context: Pick<vscode.ExtensionContext, 'workspaceState' | 'extensionUri'>) {}
  dispose() { this.watcher?.dispose(); this.changed.dispose(); }
  refresh() { this.changed.fire(); }
  private watch(root: FrameworkRoot) {
    if (this.watched === root.uri.toString()) return;
    this.watcher?.dispose(); this.watched = root.uri.toString();
    this.watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root.uri, '.ai-os/**'));
    this.watcher.onDidChange(() => this.refresh()); this.watcher.onDidCreate(() => this.refresh()); this.watcher.onDidDelete(() => this.refresh());
  }
  private root(directory: string): FrameworkRoot { return { uri: vscode.Uri.file(directory), name: path.basename(directory) }; }
  private workspaceFile(): string | undefined { return vscode.workspace.workspaceFile?.scheme === 'file' ? vscode.workspace.workspaceFile.fsPath : undefined; }
  async current(): Promise<FrameworkRoot | undefined> {
    const remembered = this.context.workspaceState.get<string>('aiOs.frameworkRoot');
    if (remembered) {
      const uri = vscode.Uri.parse(remembered);
      if (uri.scheme !== 'file') { this.problem = 'Select a local framework location.'; return; }
      const candidate = await inspectFramework(uri.fsPath);
      if (candidate?.status === 'ready') { this.problem = ''; const root = this.root(candidate.root); this.watch(root); return root; }
      this.problem = `Selected framework unavailable: ${candidate?.detail ?? uri.fsPath}. Use Select Existing Framework or Initialize to recover.`;
      return;
    }
    const candidates = await discoverFrameworks(workspacePaths(), this.workspaceFile());
    if (candidates.length === 1 && candidates[0].status === 'ready') {
      await this.remember(candidates[0].root); return this.root(candidates[0].root);
    }
    this.problem = candidates.length > 1 ? 'Multiple installations detected. Select the shared workspace framework.' : candidates[0]?.detail ?? 'Select an existing framework or initialize one for this workspace.';
    return;
  }
  private async remember(directory: string): Promise<void> {
    const root = this.root(await realpath(directory));
    await this.context.workspaceState.update('aiOs.frameworkRoot', root.uri.toString());
    this.problem = ''; this.watch(root); this.refresh();
  }
  async require(): Promise<FrameworkRoot> {
    const root = await this.current();
    if (!root) throw new Error(this.problem);
    return root;
  }
  async select(): Promise<void> {
    requireTrust();
    const candidates = await discoverFrameworks(workspacePaths(), this.workspaceFile());
    const choice = await vscode.window.showQuickPick([
      ...candidates.map(candidate => ({ label: candidate.root, description: candidate.status, directory: candidate.root })),
      { label: 'Browse for an existing framework…', directory: '' },
    ], { title: 'Select the shared AI OS location (folder containing .ai-os)' });
    if (!choice) return;
    const directory = choice.directory || (await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use framework location' }))?.[0].fsPath;
    if (!directory) return;
    requireTrust();
    const candidate = await inspectFramework(directory);
    if (candidate?.status !== 'ready') throw new Error(candidate?.detail ?? 'No valid .ai-os installation found in this folder.');
    await this.remember(directory);
  }
  async initialize(): Promise<void> {
    requireTrust();
    if (!vscode.workspace.workspaceFolders?.length) throw new Error('Open a workspace folder before initializing AI OS.');
    const remembered = this.context.workspaceState.get<string>('aiOs.frameworkRoot');
    const suggested = remembered ? vscode.Uri.parse(remembered) : this.workspaceFile() ? vscode.Uri.file(path.dirname(this.workspaceFile()!)) : vscode.workspace.workspaceFolders.length === 1 ? vscode.workspace.workspaceFolders[0].uri : undefined;
    const uri = (await vscode.window.showOpenDialog({ defaultUri: suggested, canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Initialize shared .ai-os here' }))?.[0];
    if (!uri) return;
    if (uri.scheme !== 'file') throw new Error('Choose a local filesystem folder.');
    requireTrust();
    const payload = JSON.parse(await readFile(vscode.Uri.joinPath(this.context.extensionUri, 'dist/framework.json').fsPath, 'utf8')) as FrameworkPayload;
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Initializing AI OS' }, () => initializeFramework(uri.fsPath, payload));
    await this.remember(uri.fsPath);
    void vscode.window.showInformationMessage('Shared AI OS initialized. Existing project configuration and agent hooks were left intact.');
  }
  async workflowRoot(uri: vscode.Uri): Promise<FrameworkRoot> {
    const root = await this.require();
    if (uri.scheme !== 'file' || !inside(root.uri.fsPath, uri.fsPath)) throw new Error('Workflow is outside the selected shared framework.');
    const relative = path.relative(root.uri.fsPath, uri.fsPath).split(path.sep).join('/');
    if (!relative.startsWith('.ai-os/workflows/') || !relative.endsWith('.workflow.json')) throw new Error('Save executable workflows under the selected .ai-os/workflows directory.');
    await safePath(root.uri.fsPath, relative); return root;
  }
  async validateRunTarget(repositoryUri: string): Promise<void> {
    const uri = vscode.Uri.parse(repositoryUri);
    if (uri.scheme !== 'file') throw new Error('Unsupported run repository.');
    const folder = workspacePaths().filter(root => inside(root, uri.fsPath)).sort((a, b) => b.length - a.length)[0];
    if (!folder) throw new Error('Run repository is no longer included in the workspace.');
    await resolveRepository((await this.require()).uri.fsPath, { folder: vscode.Uri.file(await realpath(folder)).toString(true), path: path.relative(folder, uri.fsPath).split(path.sep).join('/') || '.' }, workspacePaths());
  }
}
