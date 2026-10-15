import { confirmation } from '../../src/host/confirmation';
import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createFile, listFiles, safePath } from '../../src/core/files';
import { readBinding, sidecar } from '../../src/framework/tasks';
import { HostMessage, Run } from '../../src/contracts';
import type { WorkflowEditor } from '../../src/host/editor';
import type { Runner } from '../../src/core/runner';
import type { WorkspaceBinding } from '../../src/host/binding';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for workflow; see captured errors');
}

async function hashes(root: string, directory: string): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const entry of await readdir(await safePath(root, directory), { withFileTypes: true })) {
    const relative = `${directory}/${entry.name}`;
    if (relative === '.ai-os/memory/runtime' || entry.name === '__pycache__') continue;
    if (entry.isDirectory()) Object.assign(result, await hashes(root, relative));
    else if (entry.isFile()) result[relative] = createHash('sha256').update(await readFile(await safePath(root, relative))).digest('hex');
  }
  return result;
}

export async function run(): Promise<void> {
  const root = process.env.AIOS_SMOKE_WORKSPACE;
  const repository = process.env.AIOS_SMOKE_REPOSITORY;
  assert.ok(root && repository, 'Explicit live workspace and repository are required');
  const before = await hashes(root, '.ai-os');
  const token = randomUUID();
  const note = `.ai-os/memory/tasks/gui-smoke-${token}.md`;
  const title = `GUI smoke test ${token}`;
  const original = '# Temporary GUI smoke test\n\nNo existing task content is modified.\n';
  const owned: string[] = [];
  const errors: string[] = [];
  const dialogs: string[] = [];
  let run: Run | undefined;
  const extension = vscode.extensions.getExtension('ai-os.ai-os-workspace')!;
  const api = await extension.activate() as { confirmation: typeof confirmation; editor: WorkflowEditor; runner: Runner; binding: WorkspaceBinding; history: () => Run[] };
  assert.equal(path.relative(root, (await api.binding.require()).uri.fsPath), '');
  const window = new Proxy(vscode.window, { get(target, key) { return key === 'showWarningMessage' ? api.confirmation.show : Reflect.get(target, key); }, set(target, key, value) { if (key === 'showWarningMessage') { api.confirmation.show = value; confirmation.show = value; return true; } return Reflect.set(target, key, value); } });
  const originals = { showQuickPick: window.showQuickPick, showInputBox: window.showInputBox, showWarningMessage: window.showWarningMessage, showOpenDialog: window.showOpenDialog, showErrorMessage: window.showErrorMessage };
  // Dialog responses are simulated; actual registered commands and host message handlers execute.
  window.showQuickPick = (async (items: any, options: any) => {
    const choices = await items; dialogs.push(options?.title ?? '');
    if (options?.title === 'Adopt a legacy task without renaming it') return choices.find((item: string) => item === note);
    if (options?.title === 'Choose the execution target') return choices.find((item: any) => item.target.path === repository);
    if (options?.title === 'Associate this run with a task') return choices.find((item: any) => item.binding?.title === title);
    if (options?.title === 'Preview context locally') return choices[1];
    throw new Error(`Unexpected quick pick: ${options?.title}`);
  }) as typeof window.showQuickPick;
  window.showInputBox = async () => title;
  window.showWarningMessage = (async () => { dialogs.push('Approve mock run'); return 'Approve'; }) as typeof window.showWarningMessage;
  window.showOpenDialog = async () => [vscode.Uri.file(path.join(root, repository, 'package.json'))];
  window.showErrorMessage = (async (message: string) => { errors.push(message); return undefined; }) as typeof window.showErrorMessage;
  const incoming = new vscode.EventEmitter<unknown>();
  const disposed = new vscode.EventEmitter<void>();
  const messages: HostMessage[] = [];
  try {
    await createFile(root, note, original); owned.push(note);
    await vscode.commands.executeCommand('aiOs.adoptTask');
    const binding = await readBinding(root, note);
    assert.ok(binding, errors.join('\n')); owned.push(sidecar(note));
    assert.equal(await readFile(await safePath(root, note), 'utf8'), original);
    const prior = new Set(await listFiles(root, '.ai-os/workflows'));
    await vscode.commands.executeCommand('aiOs.createWorkflow');
    const created = (await listFiles(root, '.ai-os/workflows')).filter(file => !prior.has(file));
    assert.equal(created.length, 1, errors.join('\n')); owned.push(created[0]);
    const uri = vscode.Uri.file(await safePath(root, created[0]));
    assert.ok(vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'aiOs.workflow')));
    const document = await vscode.workspace.openTextDocument(uri);
    const webview = { options: {}, html: '', cspSource: 'https://test.invalid', asWebviewUri: (value: vscode.Uri) => value,
      onDidReceiveMessage: incoming.event, postMessage: async (message: HostMessage) => { messages.push(message); return true; } };
    await api.editor.resolveCustomTextEditor(document, { webview, onDidDispose: disposed.event } as unknown as vscode.WebviewPanel);
    incoming.fire({ type: 'run', revision: document.version });
    await until(() => api.history().some(item => item.workflowUri === uri.toString() && item.status === 'waitingApproval') || messages.some(item => item.type === 'error'));
    assert.deepEqual(messages.filter(item => item.type === 'error'), []);
    run = api.history().find(item => item.workflowUri === uri.toString())!;
    assert.equal(run.status, 'waitingApproval');
    assert.equal(path.relative(path.join(root, repository), vscode.Uri.parse(run.repositoryUri).fsPath), '');
    incoming.fire({ type: 'approve', runId: run.id });
    await until(() => api.history().find(item => item.id === run!.id)?.status === 'succeeded' || messages.some(item => item.type === 'error'));
    assert.equal(api.history().find(item => item.id === run!.id)?.status, 'succeeded');
    await vscode.commands.executeCommand('aiOs.previewContext');
    const preview = vscode.window.activeTextEditor?.document;
    assert.equal(preview?.uri.scheme, 'ai-os-context', errors.join('\n'));
    const pack = JSON.parse(preview!.getText());
    assert.equal(pack.task, note);
    assert.ok(pack.items.some((item: any) => item.id === 'repository:package.json'));
    assert.ok(dialogs.includes('Approve mock run'));
    assert.deepEqual(errors, []);
    console.log('LIVE WORKSPACE PASS: detection, adoption preserves note, workflow command opens canvas, mock run pauses/approves/succeeds, preview includes repository package.json.');
  } finally {
    if (run && api.runner.isActive(run.id)) { api.runner.cancel(run.id); await api.runner.wait(run.id); }
    disposed.fire(); disposed.dispose(); incoming.dispose();
    Object.assign(window, originals);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    for (const file of owned.reverse()) await unlink(await safePath(root, file));
    const after = await hashes(root, '.ai-os');
    assert.deepEqual(after, before, 'Existing framework files must retain their original bytes');
    await writeFile(path.join(extension.extensionUri.fsPath, '.vscode-test/artifacts/hiro-smoke-result.json'), JSON.stringify({
      workspace: root, repository, preservedFiles: Object.keys(before).length, temporaryFilesRemoved: owned.length,
      dialogsSimulated: true, errors, completedRun: run ? api.history().find(item => item.id === run!.id)?.status : null,
    }, null, 2));
    console.log(`PRESERVATION PASS: ${Object.keys(before).length} existing framework files unchanged; ${owned.length} temporary files removed.`);
  }
}
