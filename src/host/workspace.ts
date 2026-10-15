import * as vscode from 'vscode';
import path from 'node:path';
import { adoptTask, tasks, taskEntries, readBinding, sidecar, TaskBinding } from '../framework/tasks';
import { createFile, readText } from '../core/files';
import { exampleWorkflow, Run } from '../contracts';
import { randomUUID } from 'node:crypto';
import { WorkspaceBinding, FrameworkRoot, requireTrust, workspacePaths } from './binding';
import { RepositoryTarget, repositoryTargets, resolveRepository, detectedConfiguration } from '../framework/workspace';

function targetLabel(target: string | RepositoryTarget): string {
  return typeof target === 'string' ? target : `${path.basename(vscode.Uri.parse(target.folder).fsPath)} / ${target.path}`;
}
export async function pickRepository(title = 'Choose the execution target'): Promise<RepositoryTarget | undefined> {
  const choices = (await repositoryTargets(workspacePaths())).map(target => ({ label: targetLabel(target), description: vscode.Uri.parse(target.folder).fsPath, target }));
  if (!choices.length) throw new Error('No local repository folder is available in this workspace.');
  return (await vscode.window.showQuickPick(choices, { title }))?.target;
}
export async function pickTask(root: FrameworkRoot): Promise<TaskBinding | null | undefined> {
  const choices: { label: string; description?: string; binding: TaskBinding | null }[] = [{ label: 'Run without a task', binding: null }];
  for (const { binding } of await taskEntries(root.uri.fsPath)) {
    if (binding && !binding.archived) {
      try { await resolveRepository(root.uri.fsPath, binding.repository, workspacePaths()); }
      catch { continue; }
      choices.push({ label: binding.title, description: targetLabel(binding.repository), binding });
    }
  }
  return (await vscode.window.showQuickPick(choices, { title: 'Associate this run with a task' }))?.binding;
}

export class Item {
  constructor(readonly label: string, readonly folder: FrameworkRoot, readonly file?: string, readonly readOnly = false, readonly run?: Run, readonly repository?: RepositoryTarget) {}
}
export class WorkspaceFiles {
  constructor(private binding: WorkspaceBinding, private showRun: (run: Run) => Promise<void>) {}
  async open(item: Item): Promise<void> {
    if (!(item instanceof Item)) throw new Error('Choose an item from the AI OS dashboard.');
    if (item.repository) {
      const directory = await resolveRepository((await this.binding.require()).uri.fsPath, item.repository, workspacePaths());
      const configs = await detectedConfiguration(directory);
      void vscode.window.showInformationMessage(`${directory}: ${configs.length ? configs.join(', ') + '. Existing configuration is preserved; no automatic import or hook changes.' : 'Uses shared workspace AI OS.'}`);
      return;
    }
    if (item.run) return this.showRun(item.run);
    if (!item.file) return;
    const text = await readText(item.folder.uri.fsPath, item.file);
    const uri = vscode.Uri.joinPath(item.folder.uri, item.file);
    if (item.readOnly || !vscode.workspace.isTrusted || text.includes('<!-- AIOS-ENTRY')) {
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri.with({ scheme: 'ai-os-readonly' })), { preview: true });
    } else if (item.file.endsWith('.workflow.json')) await vscode.commands.executeCommand('vscode.openWith', uri, 'aiOs.workflow');
    else await vscode.window.showTextDocument(uri);
  }
}

export async function adoptExistingTask(workspace: WorkspaceBinding, selected?: { note: string; title: string }): Promise<void> {
  requireTrust(); const folder = await workspace.require();
  const root = folder.uri.fsPath;
  const available = await tasks(root);
  const note = selected?.note ?? await vscode.window.showQuickPick(available, { title: 'Adopt a legacy task without renaming it' });
  if (!note) return;
  if (!available.includes(note) || !note.startsWith('.ai-os/memory/tasks/')) throw new Error('Choose a working task note. Restore archived notes first.');
  if (await readBinding(root, note)) throw new Error('This task already has a repository binding.');
  const content = await readText(root, note);
  const uri = vscode.Uri.joinPath(folder.uri, note).toString();
  const assertSaved = () => { if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === uri && doc.isDirty)) throw new Error('Save or discard task source changes before selecting a repository.'); };
  assertSaved();
  const title = selected?.title ?? await vscode.window.showInputBox({ title: 'Task title', value: path.basename(note, '.md'), validateInput: value => !value.trim() || value.length > 200 ? 'Enter 1-200 characters.' : undefined });
  if (!title) return;
  const repository = await pickRepository(selected ? 'Select repository' : undefined);
  if (!repository) return;
  requireTrust();
  if ((await workspace.require()).uri.toString() !== folder.uri.toString()) throw new Error('Shared framework changed. Start again.');
  assertSaved();
  if (await readText(root, note) !== content) throw new Error('Task changed while selecting a repository. Refresh and try again.');
  const identities = [...content.matchAll(/^Task-ID:\s*([^\r\n]+)$/gm)];
  if (identities.length > 1 || identities.length && !/^[a-f0-9-]{36}$/.test(identities[0][1])) throw new Error('Resolve the task identity header before linking it.');
  const id = identities[0]?.[1] ?? randomUUID();
  if ((await taskEntries(root)).some(entry => entry.binding?.id === id)) throw new Error('Task identity is already bound.');
  const binding = await adoptTask(root, note, title, repository, workspacePaths(), undefined, id);
  if (selected) return;
  await vscode.window.showTextDocument(vscode.Uri.joinPath(folder.uri, sidecar(binding.note)));
}

export async function newWorkflow(workspace: WorkspaceBinding): Promise<void> {
  requireTrust(); const folder = await workspace.require();
  const workflow = exampleWorkflow(randomUUID());
  const file = `.ai-os/workflows/plan-review-${workflow.id.slice(0, 8)}.workflow.json`;
  await createFile(folder.uri.fsPath, file, JSON.stringify(workflow, null, 2) + '\n');
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(folder.uri, file), 'aiOs.workflow');
}
