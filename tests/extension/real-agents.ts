import { confirmation } from '../../src/host/confirmation';
import * as vscode from 'vscode';
import { strict as assert } from 'node:assert';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { createTask, readBinding } from '../../src/framework/tasks';
import { listFiles } from '../../src/core/files';
import { parseProposal, verifyProposal } from '../../src/framework/memory-proposal';
import { repositoryReview } from '../../src/core/review';
import { Run } from '../../src/contracts';
import { WorkflowEditor } from '../../src/host/editor';
import { Dashboard } from '../../src/host/dashboard';
import { Runner } from '../../src/core/runner';
import { permissionProfile, inlineToml } from '../../src/providers/boundaries';
import { WorkspaceBinding } from '../../src/host/binding';
export async function run(): Promise<void> {
  const root = process.env.AIOS_REAL_ROOT!; assert.equal(process.env.AIOS_REAL_AGENTS, '1');
  const owner = JSON.parse(await readFile(path.join(root, '.smoke-owner.json'), 'utf8')); assert.equal(owner.root, root);
  const extension = vscode.extensions.getExtension('ai-os.ai-os-workspace')!;
  const api = await extension.activate() as { confirmation: typeof confirmation; editor: WorkflowEditor; dashboard: Dashboard; runner: Runner; binding: WorkspaceBinding; history: () => Run[] };
  const approvalDialogs = { get show() { return api.confirmation.show; }, set show(value: typeof confirmation.show) { api.confirmation.show = value; confirmation.show = value; } };
  assert.equal(path.relative(root, (await api.binding.require()).uri.fsPath), '');
  const nodeCli = process.env.AIOS_REAL_NODE_PATH || 'C:/Program Files/nodejs/node.exe';
  const nativeCli = vscode.workspace.getConfiguration('aiOs').get<string>('codexPath')!;
  assert.ok(path.isAbsolute(nativeCli));
  const stoppedRun = api.history().find(run => run.workflowUri === vscode.Uri.file(path.join(root, '.ai-os/workflows/real-smoke.workflow.json')).toString());
  const oldTask = stoppedRun?.taskUri ? await readBinding(root, path.relative(root, vscode.Uri.parse(stoppedRun.taskUri).fsPath).split(path.sep).join('/')) : undefined;
  const task = oldTask ?? await createTask(root, 'Real agent smoke: add two numbers', { folder: vscode.Uri.file(root).toString(), path: '.' }, [root]);
  if (!oldTask) await writeFile(path.join(root, task.note), `# Real agent smoke: add two numbers\nTask-ID: ${task.id}\n\nOutcome: a tiny new CommonJS addition module. Implement add(a,b) in add.cjs, and add.test.cjs using node:test with add(2,3)===5. No third party dependencies.\nAll interview defaults are approved for this isolated test: Node.js, CommonJS, node:test, one flat plan, no deployment, no networking, no external services, no user code outside this fixture. This is greenfield scope and all product questions are resolved by these constraints.\n`);
  const workflow = JSON.parse(await readFile(vscode.Uri.joinPath(extension.extensionUri, 'tests/fixtures/architect-build-test.workflow.json').fsPath, 'utf8'));
  if (process.env.AIOS_REAL_MIXED === '1') { workflow.nodes.find((node: any) => node.id === 'build').config.provider = 'claude'; workflow.nodes.find((node: any) => node.id === 'test').config.readOnly = true; workflow.nodes.find((node: any) => node.id === 'build').config.prompt += '\nOn Windows shell execution is offloaded to the harness. After creating add.cjs and add.test.cjs, call AskUserQuestion to request actual sandboxed Node build/test verification and wait for its result. Do not claim commands ran before receiving actual results. Use Read/Glob/Grep/Write/Edit tools for repository and proposal changes.'; }
  for (const node of workflow.nodes.filter((node: any) => node.kind === 'agent')) node.config.prompt += '\nThis is an explicitly authorized isolated live smoke test. Keep the plan and work tiny: only add.cjs and add.test.cjs, node:test, no dependencies. Read the task for all interview answers. Restrict filesystem inspection to this fixture and the bundled runtime path supplied in context. Do not modify kernel files or request networking. Use exactly the proposal schema {version:1,target,expectedHash:null-or-SHA256,content,reason,evidence:[{scope:"framework",source,sha256}]} in .ai-os/memory/proposals/*.json. Evidence source is a current file within this fixture. Read the current task/plan files for exact hashes. This harness approves valid plan/task proposals as they appear; use AskUserQuestion to request their application and then verify saved content. Return verification entries as strings or {command,result,limitations?}, with result a string/boolean/number. Return concise output and run the actual local Node checks.';
  const workflowFile = '.ai-os/workflows/real-smoke.workflow.json'; await mkdir(path.join(root, '.ai-os/workflows'), { recursive: true }); if (!stoppedRun) await writeFile(path.join(root, workflowFile), JSON.stringify(workflow, null, 2));
  const dialogs: string[] = []; const applied = new Set<string>(); let reviewing = false;
  const originals = { warning: approvalDialogs.show, pick: vscode.window.showQuickPick, input: vscode.window.showInputBox };
  const reference = async (id: string) => { await api.dashboard.refresh(); const state = (api.dashboard as any).state; return { id, revision: state.revision }; };
  const reviewPending = async () => {
    if (reviewing) return; reviewing = true;
    try {
      for (const file of await listFiles(root, '.ai-os/memory/proposals')) {
        if (!file.endsWith('.json') || applied.has(file) || file.includes('/accepted-')) continue;
        let proposal; try { proposal = parseProposal(await readFile(path.join(root, file), 'utf8')); } catch { continue; }
        assert.ok(proposal.target === task.note || proposal.target.startsWith('.ai-os/memory/plans/'), 'Refuse unrelated memory writes');
        try { await verifyProposal(root, root, proposal); } catch {
          try { if (await readFile(path.join(root, proposal.target), 'utf8') === proposal.content) applied.add(file); } catch { /* A dependent proposal may not be ready yet. */ }
          continue;
        }
        await api.dashboard.handle({ type: 'reviewProposal', ...await reference(file) }); applied.add(file); console.log('Live smoke: approved memory proposal', file);
      }
    } finally { reviewing = false; }
  };
  vscode.window.showQuickPick = (async (items: any) => (await items)[0]) as typeof vscode.window.showQuickPick;
  vscode.window.showInputBox = (async () => { await reviewPending();
    try { await readFile(path.join(root, 'add.cjs')); await readFile(path.join(root, 'add.test.cjs'));
      const sandboxArgs = ['sandbox', '--include-managed-config', '-c', 'permissions.ai_os_readonly=' + inlineToml(permissionProfile(root, true)), '-P', 'ai_os_readonly', '-C', root];
      const checked = [];
      for (const args of [['--check', 'add.cjs'], ['--check', 'add.test.cjs'], ['--test', '--experimental-test-isolation=none', 'add.test.cjs']]) { const result = await promisify(execFile)(nativeCli, [...sandboxArgs, nodeCli, ...args], { cwd: root, windowsHide: true, timeout: 30000 }); checked.push('node ' + args.join(' ') + ' exited 0\n' + result.stdout); }
      await writeFile(path.join(root, 'host-verification.txt'), checked.join('\n')); return 'Host ran the following in the Codex read-only sandbox, with networking disabled. Actual results:\n' + checked.join('\n');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return 'Host verification failed: ' + String(error) + '\nstdout: ' + String((error as any).stdout ?? '') + '\nstderr: ' + String((error as any).stderr ?? ''); }
    return 'Use the task specification: Node.js CommonJS, add(a,b), node:test, add(2,3)=5. All recommended defaults within that tiny scope are approved. The harness applies valid plan/task proposals; verify saved files before implementation.'; }) as typeof vscode.window.showInputBox;
  approvalDialogs.show = (async (message: string, options: any, ...choices: string[]) => {
    dialogs.push(message);
    if (message === 'Approve this memory proposal?') { assert.equal(reviewing, true); return 'Approve proposal'; }
    if (message === 'Start native agent workflow?') return 'Start';
    if (message.startsWith('Approve the result and start ') || message === 'Approve this workflow result?') return 'Approve';
    if (message === 'Recover run') return 'Retry from failed phase';
    if (message === 'Retry from the failed phase?') return 'Start recovery';
    if (message === 'Record acceptance of the reviewed work?') return 'Accept reviewed work';
    if (message.startsWith('Claude: ') && ['Read', 'Glob', 'Grep', 'Write', 'Edit'].some(tool => message === 'Claude: ' + tool)) {
      const input = JSON.parse(options.detail); const file = path.resolve(root, input.file_path ?? input.path ?? '.'); const relative = path.relative(root, file);
      return !relative.startsWith('..') && !path.isAbsolute(relative) && !String(input.pattern ?? '').includes('..') ? 'Allow once' : 'Deny';
    }
    if (message === 'Codex tool approval') {
      const details = JSON.parse(options.detail); await writeFile(path.join(root, 'last-tool-approval.json'), JSON.stringify(details, null, 2)); if (details.networkApprovalContext || details.additionalPermissions) return 'Deny';
      if (details.command) return path.relative(root, details.cwd ?? '') === '' && /-Command 'git status --short'$/.test(details.command) ? 'Allow once' : 'Deny';
      if (Array.isArray(details.paths) && details.paths.every((file: string) => { const rel = path.relative(root, path.resolve(root, file)); return !rel.startsWith('..') && !path.isAbsolute(rel); })) return 'Allow once';
    }
    console.log('Live smoke: declined unexpected approval', message); return choices.includes('Deny') ? 'Deny' : undefined;
  }) as typeof approvalDialogs.show;
  let tracked: Run | undefined; let retried = false;
  try {
    await api.dashboard.show('task');
    await reviewPending();
    if (stoppedRun && ['failed', 'cancelled', 'interrupted'].includes(stoppedRun.status)) await api.editor.recoverRun(stoppedRun, 'retry');
    else await api.dashboard.handle({ type: 'runTask', ...await reference(task.note) });
    const deadline = Date.now() + 15 * 60 * 1000; let last = '';
    while (Date.now() < deadline) {
      tracked = api.history().find(run => run.taskId === task.id);
      if (tracked) {
        const summary = tracked.status + ':' + Object.entries(tracked.steps).map(([id, step]) => id + '=' + step.status).join(',');
        if (summary !== last) { last = summary; console.log('Live smoke:', summary); }
        await reviewPending();
        if (tracked.status === 'waitingApproval' && !Object.values(tracked.steps).some(step => step.toolApproval)) await api.dashboard.handle({ type: 'approveRun', ...await reference('run:' + tracked.id) });
        if (tracked.status === 'failed') {
          await api.runner.wait(tracked.id); await reviewPending();
          if (!retried && applied.size >= 2 && tracked.steps.build.status === 'failed') { retried = true; await api.editor.recoverRun(tracked, 'retry'); continue; }
          throw new Error(tracked.error + '\n' + Object.entries(tracked.steps).filter(([, step]) => step.status === 'failed').map(([, step]) => step.output).join('\n'));
        }
        if (tracked.status === 'succeeded') break;
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(tracked?.status, 'succeeded', 'Live workflow timed out'); await api.runner.wait(tracked.id);
    assert.ok(applied.size >= 2, 'Actual agent must propose plan + task pointer');
    const output = await promisify(execFile)(nativeCli, ['sandbox', '--include-managed-config', '-c', 'permissions.ai_os_readonly=' + inlineToml(permissionProfile(root, true)), '-P', 'ai_os_readonly', '-C', root, nodeCli, '--test', '--experimental-test-isolation=none', 'add.test.cjs'], { cwd: root, windowsHide: true, timeout: 30000 });
    assert.match(output.stdout, /pass 1|tests 1/);
    const review = await repositoryReview(root);
    await api.dashboard.handle({ type: 'acceptRun', ...await reference('run:' + tracked.id), runId: tracked.id, token: review.token, verification: 'Actual node --test add.test.cjs passed; only isolated fixture code.', findings: 'Accepted the tiny addition fixture only. No deployment or external services.' });
    assert.ok(api.history().find(run => run.id === tracked!.id)!.review);
    for (const [file, digest] of Object.entries(owner.kernel)) assert.equal(createHash('sha256').update(await readFile(path.join(root, '.ai-os', file))).digest('hex'), digest, 'Kernel changed: ' + file);
    await writeFile(vscode.Uri.joinPath(extension.extensionUri, '.vscode-test/artifacts', path.basename(root) + '-result.json').fsPath, JSON.stringify({ runId: tracked.id, providers: [...new Set(workflow.nodes.filter((node: any) => node.kind === 'agent').map((node: any) => node.config.provider))], status: tracked.status, applied: [...applied], retried, dialogs, tests: output.stdout, realProviderSessions: Object.values(tracked.steps).map(step => step.providerSessionId).filter(Boolean), review: api.history().find(run => run.id === tracked!.id)!.review }, null, 2));
    console.log('LIVE AGENT END TO END PASSED:', root);
  } finally { await api.runner.stop(); approvalDialogs.show = originals.warning; vscode.window.showQuickPick = originals.pick; vscode.window.showInputBox = originals.input; }
}
