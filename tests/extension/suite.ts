import { confirmation } from '../../src/host/confirmation';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryReview } from '../../src/core/review';
import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { reviewMemory } from '../../src/host/memory';
import { hash, applyProposal, parseProposal } from '../../src/framework/memory-proposal';
import { epicText } from '../fixtures/epic';
import { parseEpic } from '../../src/framework/epics';
import { storyContext } from '../../src/host/epics';
import { executionContext, trackWorkflow } from '../../src/host/execution';
import { createAgent, parseAgent, agentEntries, resolveAgents } from '../../src/framework/agents';
import { taskSnapshot } from '../../src/framework/task-edit';
import { readBinding } from '../../src/framework/tasks';
import { createTask, taskEntries } from '../../src/framework/tasks';
import { createFile } from '../../src/core/files';
import { ClientMessage, HostMessage, Run, exampleWorkflow } from '../../src/contracts';
import type { WorkflowEditor } from '../../src/host/editor';
import type { AgentProvider } from '../../src/providers/mock';
import type { Runner } from '../../src/core/runner';
import type { WorkspaceNavigation } from '../../src/host/navigation';
import type { Dashboard } from '../../src/host/dashboard';
import type { DashboardState, DashboardMessage, CreationDraft } from '../../src/dashboard-contracts';
import type { ContextPreviews } from '../../src/host/context';
import { WorkspaceBinding } from '../../src/host/binding';
import { workspacePaths } from '../../src/host/binding';
import { repositoryTargets, resolveRepository, inspectFramework } from '../../src/framework/workspace';
import { initializeFramework } from '../../src/framework/install';
import { mkdir, readFile, writeFile, rm, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

async function until(predicate: () => boolean) {
  for (let i = 0; i < 300; i++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 20)); }
  assert.fail('Timed out waiting for VS Code');
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension('ai-os.ai-os-workspace');
  assert.ok(extension, 'Extension is installed in the development host');
  const api = await extension.activate() as { confirmation: typeof confirmation; editor: WorkflowEditor; runner: Runner; binding: WorkspaceBinding; previews: ContextPreviews; dashboard: Dashboard; navigation: WorkspaceNavigation; history: () => Run[] };
  // Exercise the real presenter; intercept only the webview transport.
  const createPanel = vscode.window.createWebviewPanel;
  let respond: ((message: unknown) => unknown) | undefined; let approvalPanel: vscode.WebviewPanel | undefined;
  vscode.window.createWebviewPanel = ((...args: Parameters<typeof createPanel>) => {
    const panel = createPanel(...args); approvalPanel = panel;
    const subscribe = panel.webview.onDidReceiveMessage;
    Object.defineProperty(panel.webview, 'onDidReceiveMessage', { configurable: true, value: (callback: (message: unknown) => unknown) => { respond = callback; return subscribe.call(panel.webview, callback); } });
    return panel;
  }) as typeof createPanel;
  try {
    let settled = false;
    const pending = api.confirmation.show('Fixture approval', { detail: '<script>untrusted</script>' }, 'Allow once', 'Deny').then(value => { settled = true; return value; });
    assert.ok(approvalPanel!.webview.html.includes('&lt;script&gt;untrusted'));
    respond!({ type: 'confirmation', choice: '0' }); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(settled, false);
    respond!({ type: 'confirmation', choice: 0 }); assert.equal(await pending, 'Allow once');
    const cancelled = api.confirmation.show('Fixture close', {}, 'Approve'); approvalPanel!.dispose(); assert.equal(await cancelled, undefined);
    const question = api.confirmation.ask('How should Build continue?','Baseline unavailable',undefined,{options:[{label:'Continue investigation'},{label:'Prepare revised plan'}],recommendation:'Try available checks first',cancelLabel:'Stop run'});
    assert.ok(approvalPanel!.webview.html.includes('Suggested next step'));
    respond!({type:'question',choice:1}); assert.equal(await question,'Prepare revised plan');
    const questionAbort = new AbortController();
    const aborted = api.confirmation.ask('Which checks?','Fixture',questionAbort.signal); questionAbort.abort(); assert.equal(await aborted,null);
    assert.throws(()=>api.confirmation.ask('Invalid','',undefined,{options:[{label:42}]} as any),/Invalid agent question/);

  } finally { vscode.window.createWebviewPanel = createPanel; }
  const approvalDialogs = { get show() { return api.confirmation.show; }, set show(value: typeof confirmation.show) { api.confirmation.show = value; confirmation.show = value; } };
  if (process.env.AIOS_TEST_SCENARIO === 'restricted') {
    assert.equal(vscode.workspace.isTrusted, false);
    await assert.rejects(api.binding.initialize(), /Trust this workspace/);
    await assert.rejects(api.binding.select(), /Trust this workspace/);
    await assert.rejects(api.previews.show(), /Trust this workspace/);
    await assert.rejects(api.previews.build(null, '.', []), /Trust this workspace/);
    await assert.rejects(api.editor.recoverRun({} as Run, 'retry'), /Trust this workspace/);
    assert.ok(await api.binding.current(), 'Existing framework is still available for read-only browsing');
    await api.dashboard.show(); await api.dashboard.refresh();
    await assert.rejects(api.dashboard.handle({ type: 'action', action: 'createTask' }), /Trust this workspace/);
    await assert.rejects(api.dashboard.handle({ type: 'action', action: 'createAgent' }), /Trust this workspace/);
    await assert.rejects(api.editor.runDocument({} as vscode.TextDocument, null, { file: '.ai-os/memory/plans/epic.md', id: 'story', sha256: 'a'.repeat(64) }), /Trust this workspace/);
    await assert.rejects(api.dashboard.handle({ type: 'saveNotes', id: 'task', revision: 1, token: 'a'.repeat(64), content: 'No write' }), /not in this dashboard|Dashboard changed|Trust this workspace/);
    await assert.rejects(api.dashboard.handle({ type: 'open', id: '../secret', revision: 1 }), /not in this dashboard|Dashboard changed/);
    console.log('AI OS restricted workspace: read-only detection works; initialization and selection are blocked.');
    return;
  }
  const folder = vscode.workspace.workspaceFolders![0];
  if (process.env.AIOS_TEST_SCENARIO === 'untitled') {
    assert.equal(vscode.workspace.workspaceFolders!.length, 2);
    assert.equal(vscode.workspace.workspaceFile?.scheme, 'untitled');
  }
  const shared = await api.binding.require();
  const remembered = new Map<string, unknown>([['aiOs.frameworkRoot', vscode.Uri.joinPath(shared.uri, 'missing-framework').toString()]]);
  const state = { get: (key: string) => remembered.get(key), update: async (key: string, value: unknown) => { remembered.set(key, value); }, keys: () => [...remembered.keys()] } as vscode.Memento;
  const probe = new WorkspaceBinding({ workspaceState: state, extensionUri: extension.extensionUri });
  assert.equal(await probe.current(), undefined, 'A missing remembered installation must not silently fall back');
  assert.match(probe.problem, /unavailable/);
  probe.dispose();
  if (process.env.AIOS_TEST_SCENARIO === 'multiroot') assert.notEqual(shared.uri.fsPath, folder.uri.fsPath, 'Shared framework lives beside the workspace file, outside its folders');
  const target = (await repositoryTargets(workspacePaths()))[0];
  await mkdir(vscode.Uri.joinPath(shared.uri, '.ai-os/agents/templates').fsPath, { recursive: true });
  const frameworkAgent = { agent_id: 'supervisor', name: 'OS Supervisor', role: 'Coordinator', system_prompt_extension: 'Coordinate governed work.', allowed_skills: ['*'], execution_boundary: ['*'], approval_gate: 'high-risk-only', default_model_tier: 'reasoning' };
  await writeFile(vscode.Uri.joinPath(shared.uri, '.ai-os/agents/supervisor.json').fsPath, JSON.stringify(frameworkAgent));
  await writeFile(vscode.Uri.joinPath(shared.uri, '.ai-os/agents/index.json').fsPath, JSON.stringify({ version: '1.0.0', active_profiles: [{ agent_id: 'supervisor', name: 'OS Supervisor', file: 'agents/supervisor.json', primary: true }] }));
  await writeFile(vscode.Uri.joinPath(shared.uri, '.ai-os/agents/templates/api.json').fsPath, JSON.stringify({ ...frameworkAgent, agent_id: 'api_developer', name: 'Backend Specialist' }));
  const agentFile = await createAgent(shared.uri.fsPath, 'Integration investigator');
  const agent = parseAgent(await readFile(vscode.Uri.joinPath(shared.uri, agentFile).fsPath, 'utf8'));
  let binding = await createTask(shared.uri.fsPath, 'Integration task', target, workspacePaths());
  await api.dashboard.show(); await api.dashboard.refresh();
  const withOperation = async (message: DashboardMessage, expectedError?: RegExp) => {
    const panel = (api.dashboard as unknown as { panel: vscode.WebviewPanel }).panel;
    const original = panel.webview.postMessage; const operationId = randomUUID(); const completed: string[] = [];
    panel.webview.postMessage = async raw => {
      if (raw.type === 'operationComplete') completed.push(raw.operationId);
      if (raw.type === 'recoveryPrompt') {
        await original.call(panel.webview,raw);
        const choice=await approvalDialogs.show(raw.message,{detail:raw.detail},...raw.choices);
        if(raw.message!=='Recover run' && raw.message!=='Choose workflow for fresh recovery' && raw.message!=='Finish early') assert.ok(raw.review.includes('Previous phase results:'));
        await api.dashboard.handle({type:'answerRecovery',requestId:raw.requestId,choice:choice===undefined?null:raw.choices.indexOf(choice)});
        await assert.rejects(api.dashboard.handle({type:'answerRecovery',requestId:raw.requestId,choice:0}),/expired/);
        return true;
      }
      return original.call(panel.webview, raw);
    };
    try {
      if (expectedError) await assert.rejects(api.dashboard.handle({ ...message, operationId }), expectedError);
      else await api.dashboard.handle({ ...message, operationId });
      assert.deepEqual(completed, [operationId]);
    } finally { panel.webview.postMessage = original; }
  };
  await withOperation({ type: 'recoverRun', id: 'invalid-entry', revision: 0 }, /Unsupported dashboard action/);

  await mkdir(vscode.Uri.joinPath(shared.uri, '.ai-os/rules').fsPath, { recursive: true });
  await writeFile(vscode.Uri.joinPath(shared.uri, '.ai-os/rules/ultimate_rules.md').fsPath, '# Synthetic task intake rules');
  const drafting = api.dashboard as unknown as { draftProvider: AgentProvider; creation: CreationDraft };
  const originalDraftProvider = drafting.draftProvider;
  drafting.draftProvider = { id: 'test-only', capabilities: { cancellation: true, resume: false, toolApprovals: false }, execute: async (_node, _signal, context) => {
    assert.equal(context?.readOnly, true);
    const input = JSON.parse(context!.data);
    return JSON.stringify({ title: input.requestedTitle ?? 'Prompt task', summary: 'Requested bugfix', evidence: input.description, scope: 'Chosen repository', acceptanceCriteria: 'Bug corrected', nextSteps: 'Inspect evidence', unknowns: 'Root cause unknown' });
  } };
  const inputBox = vscode.window.showInputBox;
  const initialTasks = (await taskEntries(shared.uri.fsPath)).length;
  try {
    vscode.window.showInputBox = async () => { throw new Error('Creation must not use a global text input.'); };
    await vscode.commands.executeCommand('aiOs.createTask');
    const creation = (api.dashboard as unknown as { creation: CreationDraft }).creation;
    assert.equal(creation.kind, 'task'); assert.equal((await taskEntries(shared.uri.fsPath)).length, initialTasks);
    await api.dashboard.create('agent');
    assert.equal((api.dashboard as unknown as { creation: CreationDraft }).creation.requestId, creation.requestId, 'A second create command preserves the open form');
    await assert.rejects(api.dashboard.handle({ type: 'createTask', requestId: creation.requestId, draftId: randomUUID(), title: 'Created in form', repository: 0, notes: 'Not drafted' }), /Prepare and review/);
    await api.dashboard.handle({ type: 'prepareTask', requestId: creation.requestId, description: 'Initial ticket evidence', title: 'Created in form', repository: 0, provider: 'codex' });
    assert.equal((await taskEntries(shared.uri.fsPath)).length, initialTasks, 'Drafting does not file the task');
    const prepared = drafting.creation.prepared!;
    const request = { type: 'createTask', requestId: creation.requestId, draftId: prepared.id, title: prepared.title, repository: 0, agentId: agent.id, notes: prepared.notes };
    await api.dashboard.handle(request);
    const created = (await taskEntries(shared.uri.fsPath)).find(entry => entry.binding?.title === 'Created in form')!.binding!;
    assert.equal(created.agentId, agent.id); assert.match(await readFile(vscode.Uri.joinPath(shared.uri, created.note).fsPath, 'utf8'), /Initial ticket evidence/);
    await assert.rejects(api.dashboard.handle(request), /expired/);
    await api.dashboard.create('task');
    const promptCreation = drafting.creation;
    await api.dashboard.handle({ type: 'prepareTask', requestId: promptCreation.requestId, description: 'Prompt ticket evidence', repository: 0, provider: 'claude' });
    assert.equal((await taskEntries(shared.uri.fsPath)).length, initialTasks + 1);
    const promptDraft = drafting.creation.prepared!;
    await api.dashboard.handle({ type: 'createTask', requestId: promptCreation.requestId, draftId: promptDraft.id, title: promptDraft.title, repository: 0, notes: promptDraft.notes });
    const prompted = (await taskEntries(shared.uri.fsPath)).find(entry => entry.binding?.title === 'Prompt task')!.binding!;
    assert.match(await readFile(vscode.Uri.joinPath(shared.uri, prompted.note).fsPath, 'utf8'), /### Acceptance criteria/);
    await vscode.commands.executeCommand('aiOs.createAgent');
    const agentCreation = (api.dashboard as unknown as { creation: CreationDraft }).creation;
    await api.dashboard.handle({ type: 'createAgent', requestId: agentCreation.requestId, name: 'Created agent form', provider: 'mock', model: 'custom-model', instructions: 'Review evidence' });
    const savedAgent = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.title === 'Created agent form')!;
    assert.equal(parseAgent(await readFile(vscode.Uri.joinPath(shared.uri, savedAgent.id).fsPath, 'utf8')).model, 'custom-model');
    await api.dashboard.create('task'); const cancelled = (api.dashboard as unknown as { creation: CreationDraft }).creation;
    let waiting = false;
    drafting.draftProvider = { ...drafting.draftProvider, execute: async (_node, signal) => {
      waiting = true;
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Cancelled')), { once: true }));
    } };
    const pending = api.dashboard.handle({ type: 'prepareTask', requestId: cancelled.requestId, description: 'Cancelled prompt', repository: 0, provider: 'claude' });
    await until(() => waiting);
    await api.dashboard.handle({ type: 'cancelCreation', requestId: cancelled.requestId });
    await pending;
    assert.equal((await taskEntries(shared.uri.fsPath)).length, initialTasks + 2, 'Cancelling generation creates no task');
    await assert.rejects(api.dashboard.handle({ ...request, requestId: cancelled.requestId }), /expired/);
  } finally { vscode.window.showInputBox = inputBox; drafting.draftProvider = originalDraftProvider; }
  const navigationMessages: { type: string; page?: string }[] = [];
  const navigationInput = new vscode.EventEmitter<unknown>();
  const navigationDispose = new vscode.EventEmitter<void>();
  const navigationWebview = { options: {}, html: '', onDidReceiveMessage: navigationInput.event,
    postMessage: async (message: { type: string; page?: string }) => { navigationMessages.push(message); return true; } };
  api.navigation.resolveWebviewView({ webview: navigationWebview, onDidDispose: navigationDispose.event } as unknown as vscode.WebviewView);
  for (const page of ['task', 'epic', 'agent', 'memory', 'workflow', 'repository', 'run']) assert.ok(navigationWebview.html.includes(`data-page="${page}"`));
  assert.ok(!navigationWebview.html.includes('treeitem'));
  assert.equal((navigationWebview.html.match(/aria-hidden="true"/g) ?? []).length, 7);
  await api.dashboard.handle({ type: 'navigate', page: 'memory' });
  assert.equal(api.dashboard.page, 'memory');
  assert.ok(navigationMessages.some(message => message.page === 'memory'));
  await assert.rejects(api.dashboard.handle({ type: 'navigate', page: 'kernel-write' }), /Unsupported/);
  navigationDispose.fire(); navigationInput.dispose(); navigationDispose.dispose();
  await api.dashboard.refresh();
  const agentState = (api.dashboard as unknown as { state: DashboardState }).state;
  assert.ok(agentState.entries.some(entry => entry.title === 'OS Supervisor' && entry.kind === 'agent'));
  assert.ok(agentState.entries.some(entry => entry.template && entry.title === 'Backend Specialist'));
  await api.dashboard.handle({ type: 'useTemplate', id: '.ai-os/agents/templates/api.json', revision: agentState.revision });
  const templateDraft = (api.dashboard as unknown as { creation: CreationDraft }).creation;
  assert.equal(templateDraft.template?.name, 'Backend Specialist');
  assert.ok(!templateDraft.agents.some(entry => entry.id === 'api_developer'));
  await api.dashboard.handle({ type: 'createAgent', requestId: templateDraft.requestId, name: 'Registered backend', provider: '', model: '', instructions: templateDraft.instructions });
  const backend = (await agentEntries(shared.uri.fsPath)).find(entry => entry.agent?.name === 'Registered backend')!;
  assert.equal(backend.template, undefined); assert.equal(backend.agent?.provider, undefined);
  assert.equal(backend.agent?.role, frameworkAgent.role);
  await api.dashboard.handle({ type: 'navigate', page: 'memory' });
  const dashboardState = (api.dashboard as unknown as { state: DashboardState }).state;
  assert.ok(dashboardState.entries.some(entry => entry.id === binding.note));
  await assert.rejects(api.dashboard.handle({ type: 'open', id: '../outside', revision: dashboardState.revision }), /not in this dashboard/);
  await assert.rejects(api.dashboard.handle({ type: 'select', id: binding.note, revision: dashboardState.revision - 1 }), /Dashboard changed|Unsupported/);
  await api.dashboard.handle({ type: 'select', id: binding.note, revision: dashboardState.revision });
  await api.dashboard.handle({ type: 'open', id: binding.note, revision: dashboardState.revision });
  assert.equal(vscode.window.activeTextEditor?.document.uri.fsPath, vscode.Uri.joinPath(shared.uri, binding.note).fsPath);
  const taskReference = async () => {
    await api.dashboard.refresh();
    const snapshot = await taskSnapshot(shared.uri.fsPath, binding.note);
    const revision = (api.dashboard as unknown as { state: DashboardState }).state.revision;
    return { id: binding.note, revision, token: snapshot.token };
  };
  await api.dashboard.handle({ type: 'saveProperties', ...await taskReference(), title: binding.title, status: 'inProgress', agentId: agent.id });
  assert.equal((await readBinding(shared.uri.fsPath, binding.note))?.status, 'inProgress');
  assert.equal((await readBinding(shared.uri.fsPath, binding.note))?.agentId, agent.id);
  await api.dashboard.handle({ type: 'saveNotes', ...await taskReference(), content: `# Integration task\nTask-ID: ${binding.id}\nSaved from dashboard.\n` });
  assert.match((await taskSnapshot(shared.uri.fsPath, binding.note)).content, /Saved from dashboard/);
  const nativeNote = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, binding.note));
  await until(() => nativeNote.getText().includes('Saved from dashboard.'));
  const unsavedEdit = new vscode.WorkspaceEdit(); unsavedEdit.insert(nativeNote.uri, new vscode.Position(0, 0), 'Unsaved native note\n');
  await vscode.workspace.applyEdit(unsavedEdit);
  await assert.rejects(api.dashboard.handle({ type: 'saveProperties', ...await taskReference(), title: 'Should fail', status: 'done' }), /unsaved editor changes/);
  assert.ok(await nativeNote.save());
  const warning = approvalDialogs.show;
  approvalDialogs.show = (async () => 'Archive') as typeof approvalDialogs.show;
  try { await api.dashboard.handle({ type: 'archiveTask', ...await taskReference(), archived: true }); }
  finally { approvalDialogs.show = warning; }
  assert.equal((await readBinding(shared.uri.fsPath, binding.note))?.archived, true);
  await api.dashboard.handle({ type: 'archiveTask', ...await taskReference(), archived: false });
  assert.equal((await readBinding(shared.uri.fsPath, binding.note))?.archived, false);
  // Restore original properties so the existing context-preview checks retain their fixture.
  await api.dashboard.handle({ type: 'saveProperties', ...await taskReference(), title: binding.title, status: binding.status });
  binding = (await readBinding(shared.uri.fsPath, binding.note))!;
  const archivedNote = binding.note.replace('/tasks/', '/archived_tasks/');
  await mkdir(vscode.Uri.joinPath(shared.uri, '.ai-os/memory/archived_tasks').fsPath, { recursive: true });
  await rename(vscode.Uri.joinPath(shared.uri, binding.note).fsPath, vscode.Uri.joinPath(shared.uri, archivedNote).fsPath);
  await api.dashboard.refresh();
  const archiveSnapshot = await taskSnapshot(shared.uri.fsPath, archivedNote);
  await api.dashboard.handle({ type: 'archiveTask', id: archivedNote, revision: (api.dashboard as unknown as { state: DashboardState }).state.revision, token: archiveSnapshot.token, archived: false });
  assert.equal((await readBinding(shared.uri.fsPath, binding.note))?.id, binding.id);
  binding = (await readBinding(shared.uri.fsPath, binding.note))!;
  const contextPack = await api.previews.build(binding, binding.repository, []);
  await mkdir(vscode.Uri.joinPath(shared.uri, '.ai-os/rules').fsPath, { recursive: true });
  await writeFile(vscode.Uri.joinPath(shared.uri, '.ai-os/rules/ultimate_rules.md').fsPath, '# Synthetic test rules');
  const liveContext = await executionContext(api.binding, api.previews, binding, binding.repository);
  assert.match(liveContext.system, /Synthetic test rules/);
  assert.match(liveContext.data, new RegExp(binding.note.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  await liveContext.validate();
  const propertiesPath = vscode.Uri.joinPath(shared.uri, binding.note.replace(/\.md$/, '.task.json')).fsPath;
  const propertiesBefore = await readFile(propertiesPath, 'utf8');
  await writeFile(propertiesPath, JSON.stringify({ ...binding, title: 'Renamed during run', status: 'inProgress' }));
  await liveContext.validate();
  await writeFile(propertiesPath, JSON.stringify({ ...binding, archived: true }));
  await assert.rejects(liveContext.validate(), /identity|authorization/);
  await writeFile(propertiesPath, propertiesBefore);
  assert.ok(contextPack.items.some(item => item.source === binding.note));
  assert.equal(contextPack.repositoryRoot.toLowerCase(), (await resolveRepository(shared.uri.fsPath, binding.repository, workspacePaths())).toLowerCase());
  const proposalUri = vscode.Uri.joinPath(shared.uri, '.ai-os/memory/proposals/review-test.json');
  const reviewedTarget = '.ai-os/memory/semantic/reviewed-test.md';
  await mkdir(vscode.Uri.joinPath(shared.uri, '.ai-os/memory/proposals').fsPath, { recursive: true });
  const evidenceContent = await readFile(vscode.Uri.joinPath(shared.uri, '.ai-os/BOOT.md').fsPath, 'utf8');
  await writeFile(proposalUri.fsPath, JSON.stringify({ version: 1, target: reviewedTarget, expectedHash: null, content: '# Accepted test fact\n', reason: 'Synthetic accepted test', evidence: [{ scope: 'framework', source: '.ai-os/BOOT.md', sha256: hash(evidenceContent) }] }));
  const originalOpen = vscode.window.showOpenDialog, originalPick = vscode.window.showQuickPick, originalWarning = approvalDialogs.show, originalInfo = vscode.window.showInformationMessage;
  try {
    vscode.window.showOpenDialog = (async () => [proposalUri]) as typeof vscode.window.showOpenDialog;
    vscode.window.showQuickPick = (async (items: any) => (await items)[0]) as typeof vscode.window.showQuickPick;
    vscode.window.showInformationMessage = (async () => undefined) as typeof vscode.window.showInformationMessage;
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    await reviewMemory(api.binding);
    await assert.rejects(readFile(vscode.Uri.joinPath(shared.uri, reviewedTarget).fsPath), /ENOENT/);
    approvalDialogs.show = (async () => 'Approve proposal') as typeof approvalDialogs.show;
    vscode.window.showInformationMessage = (() => new Promise(() => {})) as typeof vscode.window.showInformationMessage;
    let toastTimeout: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([reviewMemory(api.binding), new Promise((_, reject) => { toastTimeout = setTimeout(() => reject(new Error('Saved amendment waited for informational toast dismissal')), 3000); })]); } finally { if (toastTimeout) clearTimeout(toastTimeout); }
    assert.equal(await readFile(vscode.Uri.joinPath(shared.uri, reviewedTarget).fsPath, 'utf8'), '# Accepted test fact\n');
  } finally {
    vscode.window.showOpenDialog = originalOpen; vscode.window.showQuickPick = originalPick;
    approvalDialogs.show = originalWarning; vscode.window.showInformationMessage = originalInfo;
  }
  const jsonFile = '.ai-os/workflows/json-revision-fixture.workflow.json';
  const jsonFlow = exampleWorkflow('json-revision');
  const agentOriginal = await readFile(path.join(shared.uri.fsPath, agentFile), 'utf8');
  jsonFlow.nodes[0].config.agentId = parseAgent(agentOriginal).id;
  const jsonText = JSON.stringify(jsonFlow);
  await createFile(shared.uri.fsPath, jsonFile, jsonText);
  const jsonDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, jsonFile));
  const jsonContext = await executionContext(api.binding, api.previews, binding, binding.repository);
  trackWorkflow(jsonContext, jsonDocument, await resolveAgents(shared.uri.fsPath, jsonFlow), binding);
  await jsonContext.validate();
  await writeFile(path.join(shared.uri.fsPath, agentFile), JSON.stringify({...JSON.parse(agentOriginal), name:'Externally edited selected agent'}));
  await assert.rejects(jsonContext.validate(), /selected agent configuration changed/);
  await writeFile(path.join(shared.uri.fsPath, agentFile), agentOriginal); await jsonContext.validate();
  await writeFile(path.join(shared.uri.fsPath, jsonFile), jsonText + '\n');
  await assert.rejects(jsonContext.validate(), /Run context changed/);
  await writeFile(path.join(shared.uri.fsPath, jsonFile), jsonText); await jsonContext.validate();
  await rm(path.join(shared.uri.fsPath, jsonFile));
  await assert.rejects(jsonContext.validate(), /Run context changed/);
  const autoPolicyFile = path.join(shared.uri.fsPath,'.ai-os/genome/archetypes/hobby.json');
  const autoPolicyBefore = await readFile(autoPolicyFile,'utf8');
  const autoDialogs = approvalDialogs.show;
  try {
    await writeFile(autoPolicyFile,JSON.stringify({governance:{human_approval:'never',code_review:'none'},rule_overrides:{R15:'disabled'}}));
    const autoContext = await executionContext(api.binding,api.previews,binding,binding.repository);
    const editRequest = {kind:'fileEdit' as const,paths:['src/automatic-fixture.ts'],operation:'update' as const};
    assert.equal(await autoContext.automaticApproval!(editRequest),false);
    approvalDialogs.show = (async (_message: string,_options: unknown,...choices: string[]) => { assert.ok(choices.includes('Allow automatically (this run)')); return 'Allow automatically (this run)'; }) as typeof approvalDialogs.show;
    assert.equal(await autoContext.approval('Edit fixture','diff',editRequest),true);
    assert.equal(await autoContext.automaticApproval!(editRequest),true);
    assert.equal(await autoContext.automaticApproval!({kind:'fileEdit',paths:['.ai-os/progress.md']}),false);
    const freshAutoContext = await executionContext(api.binding,api.previews,binding,binding.repository);
    assert.equal(await freshAutoContext.automaticApproval!(editRequest),false,'Run consent must not leak into fresh/recovered execution contexts');
  } finally { approvalDialogs.show = autoDialogs; await writeFile(autoPolicyFile,autoPolicyBefore); }
  const unboundContext = await executionContext(api.binding, api.previews, null, binding.repository);
  assert.deepEqual(JSON.parse(unboundContext.data).proposals, [], 'New-task drafting must not receive unrelated proposal metadata');
  const gateBinding = await createTask(shared.uri.fsPath, 'Memory gate fixture', binding.repository, workspacePaths());
  const gateTaskOriginal = await readFile(path.join(shared.uri.fsPath, gateBinding.note), 'utf8');
  const gatePlan = '.ai-os/memory/plans/memory-gate-fixture.md';
  const gatePlanContent = '# Reviewed fixture plan';
  const gatePlanFile = '.ai-os/memory/proposals/memory-gate-plan.json';
  const gatePlanProposal = parseProposal(JSON.stringify({ version: 1, target: gatePlan, expectedHash: null, content: gatePlanContent, reason: 'Fixture plan prerequisite', evidence: [{ scope: 'framework', source: '.ai-os/BOOT.md', sha256: hash(evidenceContent) }] }));
  await writeFile(path.join(shared.uri.fsPath, gatePlanFile), JSON.stringify(gatePlanProposal));
  const gateFile = '.ai-os/memory/proposals/memory-gate-fixture.json';
  const gateProposal = parseProposal(JSON.stringify({ version: 1, target: gateBinding.note, expectedHash: hash(gateTaskOriginal), content: gateTaskOriginal.replace(/^Active plan:.*$/gm, '') + '\nActive plan: memory/plans/memory-gate-fixture.md\n', reason: 'Fixture prerequisite', evidence: [{ scope: 'framework', source: gatePlan, sha256: hash(gatePlanContent) }] }));
  const gateRaw = JSON.stringify(gateProposal); await writeFile(path.join(shared.uri.fsPath, gateFile), gateRaw);
  try {
    const gateContext = await executionContext(api.binding, api.previews, gateBinding, gateBinding.repository);
    const gateNode = { ...exampleWorkflow('gate').nodes[0], config: { ...exampleWorkflow('gate').nodes[0].config, requireVerification: true } };
    assert.deepEqual(await gateContext.memoryPrerequisites!(gateNode), [gatePlanFile, gateFile]);
    await assert.rejects(gateContext.memoryReady!([gateFile]), /before continuing/);
    const readiness = api.dashboard as unknown as { memoryReady: (run: Run) => Promise<boolean> };
    const memoryRun = { steps: { build: { memoryApproval: [gateFile] } } } as unknown as Run;
    assert.equal(await readiness.memoryReady(memoryRun), false);
    await writeFile(path.join(shared.uri.fsPath, gateFile), JSON.stringify({ ...gateProposal, reason: 'Changed while waiting' }));
    await assert.rejects(gateContext.memoryReady!([gateFile]), /proposal changed/);
    await writeFile(path.join(shared.uri.fsPath, gateFile), gateRaw);
    const gateRepository = await resolveRepository(shared.uri.fsPath, binding.repository, workspacePaths());
    await applyProposal(shared.uri.fsPath, gateRepository, gatePlanProposal, async () => {});
    await applyProposal(shared.uri.fsPath, gateRepository, gateProposal, async () => {});
    await gateContext.memoryReady!([gateFile]);
    assert.equal(await readiness.memoryReady(memoryRun), true);
    await assert.rejects(gateContext.checkMemory!(), /Run context changed/);
    assert.match(await gateContext.refreshMemory!(), /memory-gate-fixture/);
    await gateContext.checkMemory!();
    let observedPlanEdit = false;
    const sourceWatcher = api.binding.onDidChange(() => { void gateContext.checkMemory!().catch(() => { observedPlanEdit = true; }); });
    await writeFile(path.join(shared.uri.fsPath, gatePlan), gatePlanContent + '\nExternal plan edit\n');
    try { await until(() => observedPlanEdit); } finally { sourceWatcher.dispose(); }
    await assert.rejects(gateContext.checkMemory!(), /Run context changed/);
    await writeFile(path.join(shared.uri.fsPath, gatePlan), gatePlanContent);
    await gateContext.checkMemory!();
    const progressProposal = { ...gateProposal, expectedHash: hash(gateProposal.content), content: gateProposal.content.replace('Active plan: memory/plans/memory-gate-fixture.md', 'Active plan: memory/plans/memory-gate-fixture.md (in-progress, 0/3)') };
    await writeFile(path.join(shared.uri.fsPath, gateFile), JSON.stringify(progressProposal));
    const progressContext = await executionContext(api.binding, api.previews, gateBinding, gateBinding.repository);
    assert.deepEqual(await progressContext.memoryPrerequisites!(gateNode), [gateFile], 'A status-only pointer change must pause the phase even when the plan path is unchanged');
    await assert.rejects(progressContext.memoryReady!([gateFile]), /before continuing/);
  } finally { await rm(path.join(shared.uri.fsPath, gateBinding.note), { force: true }); await rm(path.join(shared.uri.fsPath, gateBinding.note.replace(/\.md$/, '.task.json')), { force: true }); await rm(path.join(shared.uri.fsPath, gateFile), { force: true }); await rm(path.join(shared.uri.fsPath, gatePlanFile), { force: true }); await rm(path.join(shared.uri.fsPath, gatePlan), { force: true }); }
  await api.previews.open(contextPack);
  assert.equal(vscode.window.activeTextEditor?.document.uri.scheme, 'ai-os-context');
  assert.equal(JSON.parse(vscode.window.activeTextEditor!.document.getText()).task, binding.note);
  await assert.rejects(api.previews.build({ ...binding, title: 'Stale selection' }, binding.repository, []), /binding changed/);
  const task = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, binding.note));
  await vscode.window.showTextDocument(task);
  const taskEdit = new vscode.WorkspaceEdit(); taskEdit.insert(task.uri, new vscode.Position(task.lineCount, 0), 'A working note.\n');
  assert.ok(await vscode.workspace.applyEdit(taskEdit));
  await assert.rejects(unboundContext.validateFileEdit!(task.uri.fsPath), /unsaved editor/);
  if (process.platform === 'win32') await assert.rejects(unboundContext.validateFileEdit!(task.uri.fsPath.toUpperCase()), /unsaved editor/);
  assert.ok(await task.save());
  assert.match(Buffer.from(await vscode.workspace.fs.readFile(task.uri)).toString(), /A working note/);

  const value = exampleWorkflow('integration'); value.extra = { preserve: 'yes' };
  const relative = '.ai-os/workflows/integration.workflow.json';
  await createFile(shared.uri.fsPath, relative, JSON.stringify(value, null, 2) + '\n');
  const uri = vscode.Uri.joinPath(shared.uri, relative);
  const doc = await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc);
  const incoming = new vscode.EventEmitter<unknown>(); const disposed = new vscode.EventEmitter<void>();
  const messages: HostMessage[] = [];
  const webview = { options: {}, html: '', cspSource: 'https://test.invalid', asWebviewUri: (uri: vscode.Uri) => uri,
    onDidReceiveMessage: incoming.event, postMessage: async (message: HostMessage) => { messages.push(message); return true; } };
  const panel = { webview, onDidDispose: disposed.event } as unknown as vscode.WebviewPanel;
  await api.editor.resolveCustomTextEditor(doc, panel);
  incoming.fire({ type: 'ready' } satisfies ClientMessage);
  await until(() => messages.some(message => message.type === 'document'));
  assert.match(webview.html, /default-src 'none'/);
  const initialVersion = doc.version;
  incoming.fire({ type: 'update', revision: initialVersion, change: { kind: 'rename', name: 'Edited in canvas' } } satisfies ClientMessage);
  await until(() => doc.getText().includes('Edited in canvas') && doc.isDirty);
  assert.ok(doc.isDirty); assert.deepEqual(JSON.parse(doc.getText()).extra, { preserve: 'yes' });
  assert.ok(await doc.save());
  incoming.fire({ type: 'update', revision: initialVersion, change: { kind: 'rename', name: 'STALE' } } satisfies ClientMessage);
  await until(() => messages.some(message => message.type === 'error' && message.message.includes('stale')));
  assert.ok(!doc.getText().includes('STALE'));
  await vscode.window.showTextDocument(doc);
  await vscode.commands.executeCommand('undo');
  await until(() => JSON.parse(doc.getText()).name === 'Plan and review');
  await doc.save();

  messages.length = 0;
  const external = new vscode.WorkspaceEdit();
  external.replace(doc.uri, new vscode.Range(0, 0, doc.lineCount, 0), JSON.stringify({ ...value, name: 'External edit' }));
  assert.ok(await vscode.workspace.applyEdit(external));
  await until(() => messages.some(message => message.type === 'document' && message.workflow?.name === 'External edit'));
  await doc.save();
  incoming.fire({ type: 'update', revision: doc.version, change: { kind: 'move', nodeId: 'plan', x: 120, y: 230 } } satisfies ClientMessage);
  await until(() => JSON.parse(doc.getText()).nodes[0].position.y === 230);
  assert.ok(await doc.save());
  const disk = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString());
  assert.deepEqual(disk.nodes[0].position, { x: 120, y: 230 });
  assert.deepEqual(disk.extra, { preserve: 'yes' });
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify({ ...disk, name: 'Changed on disk' })));
  await until(() => messages.some(message => message.type === 'document' && message.workflow?.name === 'Changed on disk'));
  assert.equal(JSON.parse((await vscode.workspace.openTextDocument(uri)).getText()).name, 'Changed on disk');
  incoming.fire({ type: 'update', revision: doc.version, change: { kind: 'move', nodeId: '../escape', x: 0, y: 0 } });
  await until(() => messages.some(message => message.type === 'error' && message.message.includes('identifier')));
  assert.equal(JSON.parse(doc.getText()).name, 'Changed on disk');

  const pick = vscode.window.showQuickPick;
  vscode.window.showQuickPick = (async (items: any, options: any) => {
    assert.equal(options?.title, 'Associate this run with a task');
    return (await items).find((item: any) => item.binding?.note === binding.note);
  }) as typeof vscode.window.showQuickPick;
  try {
    incoming.fire({ type: 'run', revision: doc.version });
    await until(() => messages.some(message => message.type === 'run' && message.run.status === 'waitingApproval'));
  } finally { vscode.window.showQuickPick = pick; }
  const run = api.history().find(run => run.taskUri === task.uri.toString())!;
  assert.ok(run);
  assert.equal((run.workflow.nodes[0].config.agentSnapshot as { name: string }).name, agent.name);
  await api.dashboard.refresh();
  const taskActivity = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.id === binding.note)!;
  assert.equal(taskActivity.activity, 'Needs confirmation'); assert.equal(taskActivity.progress, 50);

  api.runner.approve(run.id); await api.runner.wait(run.id);
  assert.ok(messages.some(message => message.type === 'run' && message.run.status === 'succeeded'));
  const epicFile = '.ai-os/memory/plans/release-epic.md';
  const selectedEpicText = epicText.replace('memory/tasks/task.md', binding.note.replace('.ai-os/', ''));
  await createFile(shared.uri.fsPath, epicFile, selectedEpicText);
  await writeFile(vscode.Uri.joinPath(shared.uri, binding.note).fsPath, (await readFile(vscode.Uri.joinPath(shared.uri, binding.note).fsPath, 'utf8')) + '\nActive plan: memory/plans/release-epic.md (epic approved, 0/2 stories)\n');
  await api.dashboard.refresh();
  const epicState = (api.dashboard as unknown as { state: DashboardState }).state;
  const epicEntry = epicState.entries.find(entry => entry.id === epicFile)!;
  assert.equal(epicEntry.kind, 'epic'); assert.equal(epicEntry.epic!.completed, 0);
  assert.equal(epicState.entries.find(entry => entry.id === binding.note)!.plan, epicFile);
  const selection = { file: epicFile, id: 'investigate', sha256: epicEntry.epic!.sha256 };
  await assert.rejects(storyContext(api.binding, { ...selection, id: 'implement' }, binding), /dependencies/);
  await assert.rejects(storyContext(api.binding, { ...selection, sha256: '0'.repeat(64) }, binding), /changed/);
  const workflowBefore = doc.getText();
  const chooseWorkflow = vscode.window.showQuickPick;
  vscode.window.showQuickPick = (async (items: any, options: any) => {
    assert.equal(options?.title, 'Choose a reusable workflow for this story');
    return (await items).find((item: any) => item.file === relative);
  }) as typeof vscode.window.showQuickPick;
  try { await api.dashboard.handle({ type: 'runStory', id: epicFile, revision: epicState.revision, storyId: 'investigate', sha256: selection.sha256 }); }
  finally { vscode.window.showQuickPick = chooseWorkflow; }
  await until(() => api.history().some(run => run.story?.id === 'investigate' && run.status === 'waitingApproval'));
  const storyRun = api.history().find(run => run.story?.id === 'investigate')!;
  assert.equal(storyRun.taskId, binding.id); assert.equal(storyRun.story!.epicUri, vscode.Uri.joinPath(shared.uri, epicFile).toString());
  assert.equal(doc.getText(), workflowBefore);
  await writeFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, selectedEpicText + '\nChanged context\n');
  api.runner.approve(storyRun.id); await api.runner.wait(storyRun.id);
  assert.ok(['failed', 'cancelled'].includes(api.history().find(run => run.id === storyRun.id)!.status));
  await api.dashboard.refresh();
  const tracked = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.id === epicFile)!;
  assert.equal(tracked.epic!.completed, 0); assert.equal(tracked.epic!.stories[0].run!.id, storyRun.id);
  const nativeFixture = exampleWorkflow('native-story-test'); nativeFixture.nodes[0].config.provider = 'codex'; nativeFixture.nodes[0].config.agentId = null;
  const nativeFile = '.ai-os/workflows/native-story-test.workflow.json';
  await createFile(shared.uri.fsPath, nativeFile, JSON.stringify(nativeFixture));
  const nativeDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, nativeFile));
  const runtime = api.runner as unknown as { provider: AgentProvider }; const originalProvider = runtime.provider;
  const nativeStoryWarning = approvalDialogs.show;
  let scopedContextChecked = false;
  runtime.provider = { id: 'fake-native-story', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (_node, _signal, context) => {
    assert.equal(context!.story!.id, 'investigate');
    const data = JSON.parse(context!.data); const scope = JSON.parse(data.context);
    assert.equal(scope.selectedStory.story.id, 'investigate');
    assert.ok(!scope.taskContext.items.some((item: any) => item.source.startsWith('.ai-os/memory/plans/')));
    scopedContextChecked = true; return 'Verified simulated story context';
  } };
  approvalDialogs.show = (async () => 'Start') as typeof approvalDialogs.show;
  try {
    const currentEpic = parseEpic(await readFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, 'utf8'));
    await api.editor.runDocument(nativeDocument, binding, { file: epicFile, id: 'investigate', sha256: currentEpic.sha256 });
    await until(() => api.history().some(run => run.workflowUri === nativeDocument.uri.toString() && run.status === 'waitingApproval'));
    const nativeRun = api.history().find(run => run.workflowUri === nativeDocument.uri.toString())!;
    assert.equal(scopedContextChecked, true); api.runner.approve(nativeRun.id); await api.runner.wait(nativeRun.id);
    assert.equal(api.history().find(run => run.id === nativeRun.id)!.status, 'succeeded');
    assert.equal(parseEpic(await readFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, 'utf8')).completed, 0);
  } finally { runtime.provider = originalProvider; approvalDialogs.show = nativeStoryWarning; }
  // Lifecycle integration uses real filesystem/Git/host gates and a mock provider only.
  const lifecycleTask = await createTask(shared.uri.fsPath, 'Lifecycle task', target, workspacePaths());
  const reference = async (id: string) => { await api.dashboard.refresh(); return { id, revision: (api.dashboard as unknown as { state: DashboardState }).state.revision }; };
  const handoffSnapshot = await taskSnapshot(shared.uri.fsPath, lifecycleTask.note);
  await api.dashboard.handle({ type: 'recordHandoff', ...await reference(lifecycleTask.note), token: handoffSnapshot.token, nextStep: 'Inspect service logs', findings: 'Known failure', unknowns: 'E2E setup unavailable', verification: 'Log inspection only' });
  assert.match((await taskSnapshot(shared.uri.fsPath, lifecycleTask.note)).content, /Inspect service logs/);
  assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.status, 'open');
  await assert.rejects(api.dashboard.handle({ type: 'recordHandoff', ...await reference(lifecycleTask.note), token: handoffSnapshot.token, nextStep: 'Stale', findings: '', unknowns: '', verification: 'Not run' }), /changed on disk/);
  const pickLifecycle = vscode.window.showQuickPick;
  vscode.window.showQuickPick = (async (items: any) => (await items).find((item: any) => item.file === relative)) as typeof vscode.window.showQuickPick;
  try { await api.dashboard.handle({ type: 'runTask', ...await reference(lifecycleTask.note) }); }
  finally { vscode.window.showQuickPick = pickLifecycle; }
  await until(() => api.history().some(run => run.taskId === lifecycleTask.id && run.status === 'waitingApproval'));
  const lifecycleRun = api.history().find(run => run.taskId === lifecycleTask.id)!;
  await assert.rejects(api.dashboard.handle({ type: 'saveHandoff', ...await reference(lifecycleTask.note) }), /Finish or cancel/);
  await assert.rejects(api.dashboard.handle({ type: 'completeTask', ...await reference(lifecycleTask.note) }), /Cancel or finish/);
  await assert.rejects(api.dashboard.handle({ type: 'saveProperties', ...await reference(lifecycleTask.note), token: (await taskSnapshot(shared.uri.fsPath, lifecycleTask.note)).token, title: lifecycleTask.title, status: 'done' }), /Cancel or finish/);
  await assert.rejects(api.dashboard.handle({ type: 'reviewChanges', ...await reference(lifecycleTask.note) }), /Finish or cancel/);
  api.runner.cancel(lifecycleRun.id); await api.runner.wait(lifecycleRun.id);
  const repository = await resolveRepository(shared.uri.fsPath, lifecycleTask.repository, workspacePaths());
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: repository, windowsHide: true });
  await git('init'); await git('config', 'user.name', 'Fixture'); await git('config', 'user.email', 'fixture@example.invalid'); await git('config', 'commit.gpgsign', 'false');
  await writeFile(path.join(repository, 'review-fixture.txt'), 'baseline'); await git('add', 'review-fixture.txt'); await git('commit', '-m', 'fixture');
  const review = await repositoryReview(repository);
  const receipt = { type: 'acceptRun', runId: lifecycleRun.id, token: review.token, verification: 'Synthetic checks exercised', findings: 'Accepted fixture scope' };
  await writeFile(path.join(repository, 'review-fixture.txt'), 'changed');
  await assert.rejects(api.dashboard.handle({ ...receipt, ...await reference(lifecycleTask.note) }), /changed since review/);
  const acceptWarning = approvalDialogs.show;
  try {
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    const fresh = await repositoryReview(repository);
    await api.dashboard.handle({ ...receipt, token: fresh.token, ...await reference(lifecycleTask.note) });
    assert.equal(api.history().find(run => run.id === lifecycleRun.id)!.review, undefined);
    approvalDialogs.show = (async () => 'Accept reviewed work') as typeof approvalDialogs.show;
    await api.dashboard.handle({ ...receipt, token: fresh.token, ...await reference(lifecycleTask.note) });
    assert.equal(api.history().find(run => run.id === lifecycleRun.id)!.review!.repositoryToken, fresh.token);
    assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.status, 'open');
    assert.equal((await taskSnapshot(shared.uri.fsPath, binding.note)).content.includes('Active plan:'), true);
    await writeFile(path.join(repository, 'review-fixture.txt'), 'changed after acceptance');
    await assert.rejects(api.dashboard.handle({ type: 'saveProperties', ...await reference(lifecycleTask.note), token: (await taskSnapshot(shared.uri.fsPath, lifecycleTask.note)).token, title: lifecycleTask.title, status: 'done' }), /Review and accept/);
    await writeFile(path.join(repository, 'review-fixture.txt'), 'changed');
    approvalDialogs.show = (async () => { await writeFile(path.join(repository, 'review-fixture.txt'), 'changed during confirmation'); return 'Mark verified task done'; }) as typeof approvalDialogs.show;
    await assert.rejects(api.dashboard.handle({ type: 'saveProperties', ...await reference(lifecycleTask.note), token: (await taskSnapshot(shared.uri.fsPath, lifecycleTask.note)).token, title: lifecycleTask.title, status: 'done' }), /Review and accept/);
    assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.status, 'open');
    await writeFile(path.join(repository, 'review-fixture.txt'), 'changed');
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'completeTask', ...await reference(lifecycleTask.note) });
    assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.status, 'open');
    approvalDialogs.show = (async () => 'Mark verified task done') as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'completeTask', ...await reference(lifecycleTask.note) });
    assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.status, 'done');
    assert.equal((await readBinding(shared.uri.fsPath, lifecycleTask.note))!.id, lifecycleTask.id);
    const originalEpic = await readFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, 'utf8');
    approvalDialogs.show = (async () => 'Save verified epic') as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'saveEpic', ...await reference(epicFile), token: hash(originalEpic), content: originalEpic, verification: 'Adopt stable epic identity; leave all unfinished boxes unchecked' });
    const adoptedEpic = parseEpic(await readFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, 'utf8'));
    assert.ok(adoptedEpic.identity);
    assert.equal(api.history().find(run => run.id === storyRun.id)!.story!.epicId, adoptedEpic.identity);
    const pointerBefore = (await taskSnapshot(shared.uri.fsPath, binding.note)).content;
    const flatFile = '.ai-os/memory/plans/other-flat.md';
    await createFile(shared.uri.fsPath, flatFile, '# Plan: Other active work\n- Status: approved\n');
    const otherPointer = pointerBefore.replace(/^Active plan:.*$/m, 'Active plan: memory/plans/other-flat.md (approved, 0/1)');
    await writeFile(vscode.Uri.joinPath(shared.uri, binding.note).fsPath, otherPointer);
    const adoptedSource = await readFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, 'utf8');
    await api.dashboard.handle({ type: 'saveEpic', ...await reference(epicFile), token: hash(adoptedSource), content: adoptedSource, verification: 'Preserve the other active plan pointer' });
    assert.equal((await taskSnapshot(shared.uri.fsPath, binding.note)).content, otherPointer);
    await writeFile(vscode.Uri.joinPath(shared.uri, binding.note).fsPath, pointerBefore);
    const movedFile = epicFile.replace('.md', '-moved.md');
    await rename(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, vscode.Uri.joinPath(shared.uri, movedFile).fsPath);
    await api.dashboard.refresh();
    const moved = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.id === movedFile)!;
    assert.ok(moved.epic!.stories[0].run, 'Adopted history follows a moved epic');
    const linkedTask = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.id === binding.note)!;
    assert.equal(linkedTask.plan, movedFile); assert.equal(linkedTask.planStale, true);
    await api.dashboard.handle({ type: 'saveEpic', ...await reference(movedFile), token: moved.epic!.sha256, content: await readFile(vscode.Uri.joinPath(shared.uri, movedFile).fsPath, 'utf8'), verification: 'Repair pointer after move; no completion claimed' });
    assert.match((await taskSnapshot(shared.uri.fsPath, binding.note)).content, new RegExp(movedFile.replace('.ai-os/', '')));
    await writeFile(vscode.Uri.joinPath(shared.uri, epicFile).fsPath, await readFile(vscode.Uri.joinPath(shared.uri, movedFile).fsPath));
    await api.dashboard.refresh();
    const duplicate = (api.dashboard as unknown as { state: DashboardState }).state.entries.find(entry => entry.id === movedFile)!;
    assert.match(duplicate.problem!, /Duplicate Epic-ID/);
    await assert.rejects(api.dashboard.handle({ type: 'editEpic', ...await reference(movedFile) }), /valid linked epic/);
    await rm(vscode.Uri.joinPath(shared.uri, epicFile).fsPath);
  } finally { approvalDialogs.show = acceptWarning; }
  const legacyNote = '.ai-os/memory/tasks/selected-legacy.md'; const legacyId = randomUUID();
  const legacyText = `# Selected legacy task\nTask-ID: ${legacyId}\nPreserved working notes\n`;
  await createFile(shared.uri.fsPath, legacyNote, legacyText);
  const repositoryPicker = vscode.window.showQuickPick; const titlePrompt = vscode.window.showInputBox;
  try {
    vscode.window.showInputBox = (async () => { throw new Error('Selected task must not prompt for its title'); }) as typeof vscode.window.showInputBox;
    vscode.window.showQuickPick = (async (_items: any, options: any) => { assert.equal(options.title, 'Select repository'); return undefined; }) as typeof vscode.window.showQuickPick;
    await api.dashboard.handle({ type: 'linkRepository', ...await reference(legacyNote) });
    assert.equal(await readBinding(shared.uri.fsPath, legacyNote), undefined, 'Picker cancellation creates no binding');
    vscode.window.showQuickPick = (async (items: any, options: any) => {
      assert.equal(options.title, 'Select repository');
      await writeFile(vscode.Uri.joinPath(shared.uri, legacyNote).fsPath, legacyText + 'Changed during selection');
      return (await items).find((item: any) => JSON.stringify(item.target) === JSON.stringify(target));
    }) as typeof vscode.window.showQuickPick;
    await assert.rejects(api.dashboard.handle({ type: 'linkRepository', ...await reference(legacyNote) }), /Task changed/);
    assert.equal(await readBinding(shared.uri.fsPath, legacyNote), undefined);
    await writeFile(vscode.Uri.joinPath(shared.uri, legacyNote).fsPath, legacyText);
    vscode.window.showQuickPick = (async (items: any, options: any) => { assert.equal(options.title, 'Select repository'); return (await items).find((item: any) => JSON.stringify(item.target) === JSON.stringify(target)); }) as typeof vscode.window.showQuickPick;
    await api.dashboard.handle({ type: 'linkRepository', ...await reference(legacyNote) });
    const linked = (await readBinding(shared.uri.fsPath, legacyNote))!;
    assert.equal(linked.id, legacyId); assert.deepEqual(linked.repository, target);
    assert.equal(await readFile(vscode.Uri.joinPath(shared.uri, legacyNote).fsPath, 'utf8'), legacyText);
    await assert.rejects(api.dashboard.handle({ type: 'linkRepository', ...await reference(legacyNote) }), /unlinked working task/);
  } finally { vscode.window.showQuickPick = repositoryPicker; vscode.window.showInputBox = titlePrompt; }
  console.log('Recovery integration: development workflow');
  const development = JSON.parse(await readFile(vscode.Uri.joinPath(extension.extensionUri, 'tests/fixtures/architect-build-test.workflow.json').fsPath, 'utf8'));
  const developmentFile = '.ai-os/workflows/development-test.workflow.json';
  await createFile(shared.uri.fsPath, developmentFile, JSON.stringify(development));
  let failPhase = false; const phases: string[] = []; const phaseProvider = runtime.provider; const phaseWarning = approvalDialogs.show;
  runtime.provider = { id: 'development-host-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
    phases.push(node.id); assert.equal(context!.readOnly, node.id === 'architect-plan');
    if (node.id === 'finalize') {
      await context!.session('finalization-fixture');
      const data=JSON.parse(context!.data); const request=JSON.parse(data.context).finishRequest;
      assert.equal(request.command,node.config.finalizationCommand); assert.ok(request.priorRunId);
      if(request.command==='TASK_CLOSE') assert.match(context!.system,/Registered memory lifecycle procedure/);
      assert.equal(data.decisions.at(-1).answer,'Runtime acceptance remains unverified; keep task open');
      assert.equal(JSON.parse(await context!.refreshMemory!()).finishRequest.priorRunId,request.priorRunId);
    }
    if (failPhase && node.id === 'test') throw new Error('Recoverable host test failure');
    return node.id === 'architect-plan' ? '# Approved architecture candidate' : JSON.stringify({ status: 'passed', summary: 'Simulated verified phase', verification: ['Host fixture; actual isolated commands tested in unit suite'] });
  } };
  try {
    approvalDialogs.show = (async () => 'Start') as typeof approvalDialogs.show;
    await api.editor.runDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, developmentFile)), binding);
    await until(() => api.history().some(run => run.workflow.id === development.id && run.steps['approve-plan'].status === 'waitingApproval'));
    const developmentRun = api.history().find(run => run.workflow.id === development.id)!;
    assert.deepEqual(phases, ['architect-plan']);
    const runReference = () => reference('run:' + developmentRun.id);
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'approveRun', ...await runReference() }); assert.deepEqual(phases, ['architect-plan']);
    approvalDialogs.show = (async () => 'Approve') as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'approveRun', ...await runReference() });
    await until(() => api.history().find(run => run.id === developmentRun.id)!.steps['review-delivery'].status === 'waitingApproval');
    assert.deepEqual(phases, ['architect-plan', 'build', 'test']);
    await api.dashboard.handle({ type: 'approveRun', ...await runReference() }); await api.runner.wait(developmentRun.id);
    assert.equal(api.history().find(run => run.id === developmentRun.id)!.status, 'succeeded');
    assert.equal(api.history().find(run => run.id === developmentRun.id)!.review, undefined);
    api.history().find(run=>run.id===developmentRun.id)!.guidance=[{nodeId:'build',report:'Fixture scope',answer:'Runtime acceptance remains unverified; keep task open'}];
    const beforeFinish = api.history().length;
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    await withOperation({type:'finishRun',...await reference('run:'+developmentRun.id),runId:developmentRun.id,mode:'wrap',reason:'Save tested fixture handoff',nodeIds:[]});
    assert.equal(api.history().length,beforeFinish);
    approvalDialogs.show = (async () => 'Confirm finish action') as typeof approvalDialogs.show;
    await withOperation({type:'finishRun',...await reference('run:'+developmentRun.id),runId:developmentRun.id,mode:'close',reason:'Closure fixture',nodeIds:[]},/Review and accept/);
    await withOperation({type:'finishRun',...await reference('run:'+developmentRun.id),runId:developmentRun.id,mode:'wrap',reason:'Save tested fixture handoff',nodeIds:[]});
    const wrapped=api.history().find(run=>run.finalization?.fromRunId===developmentRun.id)!;
    assert.ok(wrapped); await api.runner.wait(wrapped.id);
    assert.equal(wrapped.workflow.nodes[0].config.finalizationCommand,'WRAP');
    assert.equal((await readBinding(shared.uri.fsPath,binding.note))!.status,binding.status);
    assert.equal(api.history().find(run=>run.id===developmentRun.id)!.status,'succeeded');
    const bundledMemory=JSON.parse(await readFile(vscode.Uri.joinPath(extension.extensionUri,'dist/framework.json').fsPath,'utf8')).files.find((file:any)=>file.path==='registry/core.memory.sk/SKILL.md');
    await createFile(shared.uri.fsPath,'.ai-os/registry/core.memory.sk/SKILL.md',bundledMemory.content);
    const accepted=api.history().find(run=>run.id===developmentRun.id)!;
    await api.runner.recordReview(accepted,{acceptedAt:new Date().toISOString(),repositoryToken:(await repositoryReview(repository)).token,verification:'Fixture verification',findings:'Fixture accepted scope'});
    const buildContext=api.previews.build; const changedFile=path.join(repository,'review-fixture.txt'); const beforeClosure=await readFile(changedFile,'utf8');
    try {
      api.previews.build=async(...args)=>{const result=await buildContext.apply(api.previews,args);await writeFile(changedFile,'Changed during closure preparation');return result;};
      await withOperation({type:'finishRun',...await reference('run:'+developmentRun.id),runId:developmentRun.id,mode:'close',reason:'Closure race fixture',nodeIds:[]},/Repository changed during closure preparation/);
    } finally {api.previews.build=buildContext;await writeFile(changedFile,beforeClosure);}
    await withOperation({type:'finishRun',...await reference('run:'+developmentRun.id),runId:developmentRun.id,mode:'close',reason:'Closure command fixture only',nodeIds:[]});
    const closing=api.history().find(run=>run.finalization?.command==='TASK_CLOSE' && run.finalization.fromRunId===developmentRun.id)!;
    assert.ok(closing);await api.runner.wait(closing.id);
    assert.equal((await readBinding(shared.uri.fsPath,binding.note))!.status,binding.status);
    const continuityFiles=['.ai-os/memory/proposals/continuity-own.json','.ai-os/memory/proposals/continuity-other.json'];
    try {
      for(let index=0;index<continuityFiles.length;index++) await createFile(shared.uri.fsPath,continuityFiles[index],JSON.stringify({version:1,target:'.ai-os/memory/episodic/sessions.jsonl',expectedHash:null,content:JSON.stringify({session_id:index?'other-run':'origin-run',started:null,ended:new Date().toISOString(),summary:'Fixture continuity',next_up:'Runtime acceptance pending'})+'\n',reason:'Fixture continuity gate',evidence:[{scope:'framework',source:binding.note,sha256:hash(await readFile(vscode.Uri.joinPath(shared.uri,binding.note).fsPath,'utf8'))}]}));
      const gate=await executionContext(api.binding,api.previews,binding,binding.repository);
      const required=await gate.memoryPrerequisites!({id:'finalize',kind:'agent',label:'WRAP',position:{x:0,y:0},config:{requireVerification:true,finalizationCommand:'WRAP',finalizationSessionId:'origin-run'}});
      assert.ok(required.includes(continuityFiles[0]));assert.ok(!required.includes(continuityFiles[1]));
      await assert.rejects(gate.memoryReady!([continuityFiles[0]]),/Review and apply/);
    } finally {for(const file of continuityFiles)await rm(vscode.Uri.joinPath(shared.uri,file).fsPath,{force:true});}
    console.log('Recovery integration: starting failed attempt');
    failPhase = true;
    approvalDialogs.show = (async () => 'Start') as typeof approvalDialogs.show;
    await api.editor.runDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, developmentFile)), binding);
    await until(() => api.history().some(run => run.workflow.id === development.id && run.id !== developmentRun.id && run.steps['approve-plan'].status === 'waitingApproval'));
    const failedRun = api.history().find(run => run.workflow.id === development.id && run.id !== developmentRun.id)!;
    approvalDialogs.show = (async () => 'Approve') as typeof approvalDialogs.show;
    await api.dashboard.handle({ type: 'approveRun', ...await reference('run:' + failedRun.id) }); await api.runner.wait(failedRun.id);
    assert.equal(api.history().find(run => run.id === failedRun.id)!.status, 'failed');
    console.log('Recovery integration: attempt failed');
    const stopped = api.history().find(run => run.id === failedRun.id)!;
    const beforeRecovery = api.history().length;
    approvalDialogs.show = (async () => undefined) as typeof approvalDialogs.show;
    await api.editor.recoverRun(stopped, 'retry'); assert.equal(api.history().length, beforeRecovery);
    await withOperation({ type: 'recoverRun', ...await reference('run:' + failedRun.id) });
    assert.equal(api.history().length, beforeRecovery);
    const recoveryFile = path.join(repository, 'review-fixture.txt'); const beforeRace = await readFile(recoveryFile, 'utf8');
    approvalDialogs.show = (async () => { await writeFile(recoveryFile, 'Changed during recovery approval'); return 'Start recovery'; }) as typeof approvalDialogs.show;
    await assert.rejects(api.editor.recoverRun(stopped, 'retry'), /repository changed during recovery review/);
    assert.equal(api.history().length, beforeRecovery); await writeFile(recoveryFile, beforeRace);
    console.log('Recovery integration: cancelled recovery');
    failPhase = false; const oldPhases = phases.length;
    const recoveryPicker = vscode.window.showQuickPick;
    try {
      vscode.window.showQuickPick = (async () => 'Retry from failed phase') as unknown as typeof vscode.window.showQuickPick;
      approvalDialogs.show = (async (message: string) => message === 'Recover run' ? 'Retry from failed phase' : 'Start recovery') as typeof approvalDialogs.show;
      vscode.window.showQuickPick = (async () => { throw new Error('Recovery must not open the global picker'); }) as typeof vscode.window.showQuickPick;
      console.log('Recovery integration: invoking retry');
      await withOperation({ type: 'recoverRun', ...await reference('run:' + failedRun.id) });
      await until(() => api.history().some(run => run.recovery?.fromRunId === failedRun.id && run.steps['review-delivery'].status === 'waitingApproval'));
      const recovered = api.history().find(run => run.recovery?.fromRunId === failedRun.id)!;
      assert.deepEqual(phases.slice(oldPhases), ['test']); assert.notEqual(recovered.id, failedRun.id);
      assert.equal(recovered.review, undefined); assert.equal(api.history().find(run => run.id === failedRun.id)!.status, 'failed');
      approvalDialogs.show = (async () => 'Approve') as typeof approvalDialogs.show;
      await api.dashboard.handle({ type: 'approveRun', ...await reference('run:' + recovered.id) }); await api.runner.wait(recovered.id);
      const recoveryDocument = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri, developmentFile));
      const missingSource = { ...stopped, workflowUri: vscode.Uri.joinPath(shared.uri, '.ai-os/workflows/deleted.workflow.json').toString(), repositoryUri: stopped.repositoryUri.replace(/file:\/\/\/C%3A/, 'file:///c%3A') };
      await assert.rejects(api.editor.recoverRun(missingSource, 'retry'), /original workflow is missing/);
      approvalDialogs.show = (async () => 'Start recovery') as typeof approvalDialogs.show;
      const restarted = await api.editor.recoverRun(missingSource, 'fresh', recoveryDocument);
      assert.ok(restarted); await until(() => api.history().find(run => run.id === restarted.id)?.steps['approve-plan'].status === 'waitingApproval');
      assert.equal(restarted.workflowUri, recoveryDocument.uri.toString()); assert.equal(restarted.recovery?.fromRunId, stopped.id);
      api.runner.cancel(restarted.id); await api.runner.wait(restarted.id);
      const recoveryCards: string[] = [];
      approvalDialogs.show = (async (message: string, _options: unknown, ...choices: string[]) => {
        recoveryCards.push(message);
        if (message === 'Recover run') return 'Start fresh run';
        if (message === 'Choose workflow for fresh recovery') { assert.ok(choices.includes(developmentFile)); return developmentFile; }
        if (message === 'Start this workflow from the beginning?') return 'Start recovery';
        return undefined;
      }) as typeof approvalDialogs.show;
      const freshFromCards = await vscode.commands.executeCommand<Run>('aiOs.recoverRun', failedRun.id);
      assert.ok(freshFromCards); await until(() => api.history().find(run => run.id === freshFromCards.id)?.steps['approve-plan'].status === 'waitingApproval');
      assert.deepEqual(recoveryCards, ['Recover run', 'Choose workflow for fresh recovery', 'Start this workflow from the beginning?']);
      api.runner.cancel(freshFromCards.id); await api.runner.wait(freshFromCards.id);
      const previousIds=new Set(api.history().map(run=>run.id)); recoveryCards.length=0;
      await withOperation({type:'recoverRun',...await reference('run:'+failedRun.id)});
      const inlineFresh=api.history().find(run=>!previousIds.has(run.id) && run.recovery?.fromRunId===failedRun.id)!;
      assert.ok(inlineFresh); await until(()=>api.history().find(run=>run.id===inlineFresh.id)?.steps['approve-plan'].status==='waitingApproval');
      assert.deepEqual(recoveryCards,['Recover run','Choose workflow for fresh recovery','Start this workflow from the beginning?']);
      api.runner.cancel(inlineFresh.id); await api.runner.wait(inlineFresh.id);



    } finally { vscode.window.showQuickPick = recoveryPicker; }
    const beforeActiveWrap=new Set(api.history().map(run=>run.id));
    approvalDialogs.show=(async()=>'Start') as typeof approvalDialogs.show;
    await api.editor.runDocument(await vscode.workspace.openTextDocument(vscode.Uri.joinPath(shared.uri,developmentFile)),binding);
    await until(()=>api.history().some(run=>!beforeActiveWrap.has(run.id) && run.steps['approve-plan']?.status==='waitingApproval'));
    const activeWrap=api.history().find(run=>!beforeActiveWrap.has(run.id))!;
    activeWrap.guidance=[{nodeId:'build',report:'Fixture',answer:'Runtime acceptance remains unverified; keep task open'}];
    approvalDialogs.show=(async()=>'Confirm finish action') as typeof approvalDialogs.show;
    await withOperation({type:'finishRun',...await reference('run:'+activeWrap.id),runId:activeWrap.id,mode:'wrap',reason:'Stop and hand off fixture',nodeIds:[]});
    assert.equal(api.runner.isActive(activeWrap.id),false);
    assert.equal(api.history().find(run=>run.id===activeWrap.id)!.status,'cancelled');
    const activeWrapped=api.history().find(run=>run.finalization?.fromRunId===activeWrap.id)!;assert.ok(activeWrapped);await api.runner.wait(activeWrapped.id);

  } finally { runtime.provider = phaseProvider; approvalDialogs.show = phaseWarning; }
  disposed.fire(); incoming.dispose(); disposed.dispose();
  await vscode.commands.executeCommand('vscode.openWith', uri, 'aiOs.workflow');
  await until(() => vscode.window.tabGroups.all.some(group => group.tabs.some(tab => tab.input instanceof vscode.TabInputCustom && tab.input.viewType === 'aiOs.workflow')));
  await vscode.commands.executeCommand('workbench.action.closeAllEditors');
  const added = path.join(shared.uri.fsPath, `added-${randomUUID()}`);
  await mkdir(added);
  const payload = JSON.parse(await readFile(vscode.Uri.joinPath(extension.extensionUri, 'dist/framework.json').fsPath, 'utf8'));
  await createFile(added, '.claude/settings.json', '{"keep":"existing-config"}');
  await initializeFramework(added, payload);
  assert.equal((await inspectFramework(added))?.status, 'ready');
  assert.equal(await readFile(path.join(added, '.claude/settings.json'), 'utf8'), '{"keep":"existing-config"}');
  // Container -> multi-root transitions may restart the extension host; mutate folders in the saved multi-root scenario.
  if (process.env.AIOS_TEST_SCENARIO === 'multiroot') {
  const previousCount = vscode.workspace.workspaceFolders!.length;
  let foldersChanged = false;
  const folderEvents = vscode.workspace.onDidChangeWorkspaceFolders(() => { foldersChanged = true; });
  assert.ok(vscode.workspace.updateWorkspaceFolders(previousCount, 0, { uri: vscode.Uri.file(added), name: 'Added project' }));
  await until(() => foldersChanged && vscode.workspace.workspaceFolders!.length === previousCount + 1);
  assert.equal((await api.binding.require()).uri.toString(), shared.uri.toString(), 'Adding a project with .ai-os must not change the shared binding');
  const addedTarget = (await repositoryTargets(workspacePaths())).find(target => vscode.Uri.parse(target.folder).fsPath.toLowerCase() === added.toLowerCase())!;
  assert.ok(addedTarget);
  await resolveRepository(shared.uri.fsPath, addedTarget, workspacePaths());
  const unset = { get: () => undefined, update: async () => {}, keys: () => [] } as vscode.Memento;
  const ambiguous = new WorkspaceBinding({ workspaceState: unset, extensionUri: extension.extensionUri });
  assert.equal(await ambiguous.current(), undefined);
  assert.match(ambiguous.problem, /Multiple/);
  ambiguous.dispose();
  foldersChanged = false;
  assert.ok(vscode.workspace.updateWorkspaceFolders(previousCount, 1));
  await until(() => foldersChanged && vscode.workspace.workspaceFolders!.length === previousCount);
  await assert.rejects(resolveRepository(shared.uri.fsPath, addedTarget, workspacePaths()), /no longer included/);
  assert.equal((await api.binding.require()).uri.toString(), shared.uri.toString());
  folderEvents.dispose();
  }
  await rm(added, { recursive: true, force: true });
  console.log(`AI OS integration (${process.env.AIOS_TEST_SCENARIO}): editor, runs, shared binding and bundled installation/config preservation passed${process.env.AIOS_TEST_SCENARIO === 'multiroot' ? ', including folder add/remove' : ''}.`);
}
