import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { parseWorkflow, Run } from '../src/contracts';
import { parseVerificationReport } from '../src/core/verification';
import { Runner, RunStore } from '../src/core/runner';
import { AgentProvider } from '../src/providers/mock';
async function waitFor(store: RunStore, predicate: (run: Run) => boolean): Promise<Run> {
  for (let count = 0; count < 400; count++) { const run = (await store.list())[0]; if (run && predicate(run)) return run; if (run?.status === 'failed') throw new Error(run.error); if (store.problems.length) throw new Error(store.problems.join('; ')); await new Promise(resolve => setTimeout(resolve, 10)); }
  throw new Error('Workflow did not reach the expected gate.');
}
test('architect approval gates a real isolated build/test and final review; cancellation/failure stop later phases', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  for (const scenario of ['pass', 'cancel-plan', 'fail-test', 'malformed-build', 'blocked-build']) {
    const root = await mkdtemp(path.join(os.tmpdir(), 'aios-development-')); const store = new RunStore(path.join(root, '.runs'));
    const called: string[] = []; const testEnv = { ...process.env }; delete testEnv.NODE_TEST_CONTEXT;
    const provider: AgentProvider = { id: 'isolated-development-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
      called.push(node.id);
      if (node.id === 'architect-plan') { assert.equal(context!.readOnly, true); await context!.output?.('# Architecture plan\nBuild add(a,b). Acceptance: add(2,3) equals 5.'); return '# Architecture plan\nBuild add(a,b). Acceptance: add(2,3) equals 5.'; }
      assert.equal(context!.readOnly, false);
      const previous = JSON.parse(context!.data).previousSteps; assert.match(previous['architect-plan'], /Architecture plan/); assert.equal(previous['approve-plan'], 'Approved by the user.');
      if (node.id === 'build') {
        if (scenario === 'blocked-build') return JSON.stringify({ status: 'blocked', summary: 'Apply reviewed plan proposal before implementation', verification: [{ command: 'Test-Path approved-plan.md', result: false, limitations: 'Memory approval pending' }] });
        if (scenario === 'malformed-build') return 'Built successfully without verification';
        await writeFile(path.join(root, 'add.cjs'), 'module.exports = (a,b) => a+b;');
        const result = await promisify(execFile)(process.execPath, ['--check', 'add.cjs'], { cwd: root, windowsHide: true });
        return JSON.stringify({ status: 'passed', summary: 'Built approved addition module', verification: ['node --check add.cjs exited 0', result.stdout] });
      }
      await writeFile(path.join(root, 'add.test.cjs'), `const {test}=require('node:test');const assert=require('node:assert/strict');const add=require('./add.cjs');test('approved acceptance',()=>assert.equal(add(2,3),${scenario === 'fail-test' ? 6 : 5}));`);
      try { const result = await promisify(execFile)(process.execPath, ['--test', 'add.test.cjs'], { cwd: root, windowsHide: true, env: testEnv }); return JSON.stringify({ status: 'passed', summary: 'Acceptance test passed', verification: [result.stdout] }); }
      catch { return JSON.stringify({ status: 'failed', summary: 'Acceptance test exited nonzero', verification: ['node --test add.test.cjs failed'] }); }
    } };
    const runner = new Runner(store, provider, () => {}, error => { throw error; });
    const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {} };
    try {
      const run = await runner.start(workflow, 'file:///development.workflow.json', 'file:///isolated', undefined, context);
      await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval');
      assert.deepEqual(called, ['architect-plan']); await assert.rejects(access(path.join(root, 'add.cjs')));
      if (scenario === 'cancel-plan') { runner.cancel(run.id); await runner.wait(run.id); assert.deepEqual(called, ['architect-plan']); continue; }
      runner.approve(run.id);
      const result = await waitFor(store, run => run.status === 'failed' || run.steps['review-delivery'].status === 'waitingApproval');
      if (scenario === 'pass') { assert.deepEqual(called, ['architect-plan', 'build', 'test']); assert.equal(result.status, 'waitingApproval'); assert.throws(() => runner.approve(run.id, 'approve-plan'), /stale/); runner.approve(run.id, 'review-delivery'); await runner.wait(run.id); assert.equal((await store.list())[0].status, 'succeeded'); assert.equal((await store.list())[0].review, undefined); }
      else { assert.equal(result.status, 'failed', scenario); assert.equal(result.steps['review-delivery'].status, 'queued'); if (['malformed-build', 'blocked-build'].includes(scenario)) assert.ok(!called.includes('test')); if (scenario === 'blocked-build') { assert.match(result.error!, /blocked - Apply reviewed plan proposal/); assert.doesNotMatch(result.error!, /Invalid verification/); } }
    } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
  }
});


test('recovery forks a new run, retains only completed results on retry and preserves final human approval', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-recover-')); const store = new RunStore(path.join(root, '.runs'));
  const called: string[] = [];
  const provider: AgentProvider = { id: 'recovery-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
    called.push(node.id); await context!.session('new-session-' + context!.runId);
    if (node.id === 'architect-plan') return 'New plan';
    assert.equal(JSON.parse(context!.data).previousSteps['approve-plan'], 'Approved by the user.');
    return JSON.stringify({ status: 'passed', summary: 'Verified current files', verification: ['Actual command exited 0'] });
  } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {} };
  const source: Run = { version: 1, id: '11111111-1111-1111-1111-111111111111', workflow, workflowUri: 'file:///development.workflow.json', repositoryUri: 'file:///isolated', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), status: 'failed', error: 'Tests failed after partial edits', steps: Object.fromEntries(workflow.nodes.map(node => [node.id, node.id === 'test' ? { status: 'failed', output: 'Failure evidence', providerSessionId: 'old-session' } : node.id === 'review-delivery' ? { status: 'queued' } : { status: 'succeeded', output: node.id === 'approve-plan' ? 'Approved by the user.' : 'Saved earlier result' }])) };
  const original = JSON.stringify(source);
  try {
    await store.save(source);
    const retry = await runner.recover(source, 'retry', context);
    assert.notEqual(retry.id, source.id); assert.equal(retry.recovery!.fromRunId, source.id);
    for (let i = 0; i < 200 && !(await store.list()).find(run => run.id === retry.id && run.status === 'waitingApproval'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    const pending = (await store.list()).find(run => run.id === retry.id)!;
    assert.equal(pending.status, 'waitingApproval'); assert.deepEqual(called, ['test']);
    assert.equal(pending.steps.test.providerSessionId, 'new-session-' + retry.id); assert.equal(pending.steps.build.providerSessionId, undefined); assert.equal(pending.review, undefined);
    runner.approve(retry.id); await runner.wait(retry.id);
    assert.equal(JSON.stringify(source), original); assert.equal((await store.list()).find(run => run.id === source.id)!.status, 'failed');
    const fresh = await runner.recover(source, 'fresh', context);
    for (let i = 0; i < 200 && !(await store.list()).find(run => run.id === fresh.id && run.status === 'waitingApproval'); i++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal((await store.list()).find(run => run.id === fresh.id)!.steps['approve-plan'].status, 'waitingApproval');
    assert.deepEqual(called, ['test', 'architect-plan']); runner.cancel(fresh.id); await runner.wait(fresh.id);
    await assert.rejects(runner.recover({ ...source, status: 'succeeded' }, 'retry', context), /unsuccessful/);
    await assert.rejects(runner.recover(source, 'retry', { ...context, validate: async () => { throw new Error('Policy changed'); } }), /Policy changed/);
    const missing = structuredClone(source); delete missing.steps.build.output;
    await assert.rejects(runner.recover(missing, 'retry', context), /no saved result/);
    const neverStarted = structuredClone(source); neverStarted.id = '33333333-3333-3333-3333-333333333333'; neverStarted.status = 'queued'; neverStarted.steps = Object.fromEntries(workflow.nodes.map(node => [node.id, { status: 'queued' }]));
    await store.save(neverStarted);
    const interrupted = (await store.recover()).find(run => run.id === neverStarted.id)!; assert.equal(interrupted.status, 'interrupted');
    const restarted = await runner.recover(interrupted, 'fresh', context); runner.cancel(restarted.id); await runner.wait(restarted.id);
    const retried = await runner.recover(interrupted, 'retry', context); runner.cancel(retried.id); await runner.wait(retried.id);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('verification reports accept text and structured evidence while rejecting malformed pass claims', () => {
  const report = { status: 'blocked', summary: 'Save the approved plan first', verification: [{ command: 'Test-Path plan.md', result: false, limitations: 'Human memory approval pending' }] };
  assert.deepEqual(parseVerificationReport(JSON.stringify(report)), report);
  const nonstandard = { ...report, verification: [{ limitation: 'Sandbox initialization blocked' }] };
  assert.equal(parseVerificationReport(JSON.stringify(nonstandard)).verification[0], JSON.stringify(nonstandard.verification[0]));
  assert.equal(parseVerificationReport(JSON.stringify({ ...report, status: 'passed', verification: ['Exit code 0', '', { command: 'tests', result: 0 }] })).status, 'passed');
  for (const verification of [[], [null], [true], [{ command: '', result: 'passed' }], [{ command: 'tests', result: {} }], [{ command: 'tests', result: 'ok', limitations: false }]]) assert.throws(() => parseVerificationReport(JSON.stringify({ ...report, status: 'passed', verification })), /Invalid verification/);
});


test('memory prerequisites pause before Build and continuation rechecks approval without replaying architecture', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-memory-wait-')); const store = new RunStore(path.join(root, '.runs'));
  const called: string[] = []; let pending = true; let refreshed = false;
  const provider: AgentProvider = { id: 'memory-wait-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
    called.push(node.id);
    if (node.id === 'architect-plan') return 'Approved architecture';
    assert.equal(refreshed, true); assert.match(context!.data, /fresh-memory-context/);
    return JSON.stringify({ status: 'passed', summary: 'Verified', verification: ['Fixture assertion passed'] });
  } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {}, memoryPrerequisites: async (node: any) => node.id === 'build' && pending ? ['.ai-os/memory/proposals/task-pointer.json'] : [], memoryReady: async () => { if (pending) throw new Error('Memory approval is still pending'); }, refreshMemory: async () => { refreshed = true; return 'fresh-memory-context'; } };
  try {
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval'); runner.approve(run.id, 'approve-plan');
    const paused = await waitFor(store, run => Boolean(run.steps.build.memoryApproval));
    assert.equal(paused.status, 'waitingApproval'); assert.equal(paused.error, undefined); assert.equal(paused.steps.test.status, 'queued'); assert.deepEqual(called, ['architect-plan']);
    await assert.rejects(runner.continueMemory(run.id), /still pending/); assert.equal(runner.isActive(run.id), true);
    assert.throws(() => runner.approve(run.id), /not waiting for approval/);
    pending = false; await runner.continueMemory(run.id);
    await waitFor(store, run => run.steps['review-delivery'].status === 'waitingApproval');
    assert.deepEqual(called, ['architect-plan', 'build', 'test']);
    runner.approve(run.id, 'review-delivery'); await runner.wait(run.id);
    const done = (await store.list())[0]; assert.equal(done.status, 'succeeded'); assert.equal(done.steps.build.memoryApproval, undefined); assert.equal(done.review, undefined);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('a late memory prerequisite pauses a blocked provider result, and cancellation stops the wait', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-late-memory-')); const store = new RunStore(path.join(root, '.runs'));
  let pending = false; const called: string[] = [];
  const provider: AgentProvider = { id: 'late-memory-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async node => { called.push(node.id); if (node.id === 'architect-plan') return 'Plan'; pending = true; return JSON.stringify({ status: 'blocked', summary: 'Review task pointer proposal', verification: [] }); } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {}, memoryPrerequisites: async () => pending ? ['.ai-os/memory/proposals/pointer.json'] : [], memoryReady: async () => { throw new Error('Not approved'); } };
  try {
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval'); runner.approve(run.id);
    const paused = await waitFor(store, run => Boolean(run.steps.build.memoryApproval)); assert.equal(paused.error, undefined); assert.equal(paused.status, 'waitingApproval');
    runner.cancel(run.id); await runner.wait(run.id); assert.equal((await store.list())[0].status, 'cancelled'); assert.deepEqual(called, ['architect-plan', 'build']);
    await assert.rejects(runner.continueMemory(run.id), /No memory approval/);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('cancellation during asynchronous memory prerequisite discovery cannot strand the run', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-memory-cancel-')); const store = new RunStore(path.join(root, '.runs'));
  let release!: (files: string[]) => void; let started!: () => void;
  const discovering = new Promise<void>(resolve => { started = resolve; });
  const pending = new Promise<string[]>(resolve => { release = resolve; });
  const provider: AgentProvider = { id: 'cancel-memory-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async () => 'Plan' };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {}, memoryPrerequisites: async (node: any) => { if (node.id !== 'build') return []; started(); return pending; } };
  try {
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval'); runner.approve(run.id);
    await discovering; runner.cancel(run.id); release(['.ai-os/memory/proposals/pointer.json']);
    await runner.wait(run.id); assert.equal((await store.list())[0].status, 'cancelled');
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('blocked verification waits for guidance and continues only the same phase; closing cancels', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  for (const scenario of ['custom','choice','stop']) {
    const cancel = scenario === 'stop';
    const expectedAnswer = scenario === 'choice' ? 'Continue investigation: Try available read-only checks within existing permissions and report what still blocks progress.' : 'Propose focused tests; preserve final runtime acceptance';
    const root = await mkdtemp(path.join(os.tmpdir(), 'aios-guidance-'));
    const store = new RunStore(path.join(root, '.runs'));
    let answer!: (value: string | null) => void; let questions = 0;
    const calls: string[] = [];
    const provider: AgentProvider = { id: 'guidance-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
      calls.push(node.id);
      if (node.id === 'architect-plan') return 'Approved architecture';
      if (node.id === 'build' && calls.filter(id => id === 'build').length === 1) return JSON.stringify({ status: 'blocked', summary: 'Live baseline unavailable; approve a revised procedure', verification: ['Checked available runtime tools'] });
      if (node.id === 'build' || node.id === 'test') {
        const decisions = JSON.parse(context!.data).decisions;
        assert.equal(decisions[0].answer, expectedAnswer);
        assert.match(decisions[0].report, /Live baseline/);
      }
      return JSON.stringify({ status: 'passed', summary: 'Verified phase', verification: ['Fixture assertions passed'] });
    } };
    const runner = new Runner(store, provider, () => {}, error => { throw error; });
    const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {}, input: async (question: any) => { assert.match(question.question,/How should/); assert.match(question.details,/Live baseline/); assert.equal(question.options[1].label,'Prepare revised plan'); assert.equal(question.cancelLabel,'Stop run'); questions++; return new Promise<string | null>(resolve => { answer = resolve; }); } };
    try {
      const run = await runner.start(workflow, 'file:///flow', 'file:///isolated', undefined, context);
      await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval');
      runner.approve(run.id);
      await waitFor(store, run => run.steps.build.toolApproval === true);
      assert.equal(questions, 1); assert.deepEqual(calls, ['architect-plan', 'build']);
      answer(cancel ? null : scenario === 'choice' ? 'Continue investigation' : expectedAnswer);
      if (cancel) { await runner.wait(run.id); assert.equal((await store.list())[0].status, 'cancelled'); assert.deepEqual(calls, ['architect-plan', 'build']); }
      else {
        await waitFor(store, run => run.steps['review-delivery'].status === 'waitingApproval');
        assert.deepEqual(calls, ['architect-plan', 'build', 'build', 'test']);
        runner.approve(run.id); await runner.wait(run.id);
        const saved = (await store.list())[0];
        assert.equal(saved.status, 'succeeded');
        assert.equal(saved.guidance![0].answer, expectedAnswer);
        const recovered = await runner.recover({ ...saved, status: 'failed', steps: { ...saved.steps, test: {status:'failed'}, 'review-delivery':{status:'queued'} } }, 'retry', context);
        for (let count = 0; count < 200 && !(await store.list()).find(run => run.id === recovered.id && run.steps['review-delivery'].status === 'waitingApproval'); count++) await new Promise(resolve => setTimeout(resolve, 10));
        assert.equal((await store.list()).find(run => run.id === recovered.id)!.steps['review-delivery'].status, 'waitingApproval');
        runner.approve(recovered.id); await runner.wait(recovered.id);
        const freshFlow = structuredClone(workflow);
        freshFlow.nodes = freshFlow.nodes.filter(node => node.id === 'test'); freshFlow.edges = [];
        const fresh = await runner.start(freshFlow, 'file:///replacement', 'file:///isolated', undefined, context, {fromRunId:saved.id,fromNodeId:'build',mode:'fresh'}, saved.guidance);
        await runner.wait(fresh.id);
        assert.equal((await store.list()).find(run => run.id === fresh.id)!.status, 'succeeded');

      }
    } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
  }
});


test('memory continuation carries its checkpoint and clears the stale current result', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-checkpoint-')); const store = new RunStore(path.join(root, '.runs'));
  let pending = false; let attempts = 0;
  const blocked = JSON.stringify({ status: 'blocked', summary: 'Plan proposal awaits review', verification: [] });
  const provider: AgentProvider = { id: 'checkpoint-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (node, _signal, context) => {
    if (node.id === 'architect-plan') return 'Plan';
    if (node.id === 'build' && ++attempts === 1) { pending = true; return blocked; }
    if (node.id === 'build') {
      const data = JSON.parse(context!.data);
      assert.equal(data.continuation.previousReport, blocked);
      assert.equal(data.context, 'reviewed current memory');
      const saved = (await store.list())[0];
      assert.equal(saved.steps.build.output, undefined);
      assert.equal(saved.steps.build.previousOutput, blocked);
      assert.equal(saved.steps.build.status, 'running');
    }
    return JSON.stringify({ status: 'passed', summary: 'Verified', verification: ['Fixture passed'] });
  } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {}, memoryPrerequisites: async () => pending ? ['.ai-os/memory/proposals/plan.json'] : [], memoryReady: async () => { assert.equal(pending, false); }, refreshMemory: async () => 'reviewed current memory' };
  try {
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    await waitFor(store, run => run.steps['approve-plan'].status === 'waitingApproval'); runner.approve(run.id);
    await waitFor(store, run => Boolean(run.steps.build.memoryApproval));
    pending = false; await runner.continueMemory(run.id);
    await waitFor(store, run => run.steps['review-delivery'].status === 'waitingApproval');
    runner.approve(run.id); await runner.wait(run.id);
    assert.equal((await store.list())[0].status, 'succeeded'); assert.equal(attempts, 2);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('explicit recovery retains a checkpoint when continuation failed before returning output', async () => {
  const workflow = parseWorkflow(await readFile('tests/fixtures/architect-build-test.workflow.json', 'utf8'));
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-checkpoint-retry-')); const store = new RunStore(path.join(root, '.runs'));
  let received = '';
  const provider: AgentProvider = { id: 'checkpoint-retry', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (_node, _signal, context) => { received = context!.data; throw new Error('Fixture stops after inspecting context'); } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  const stamp = new Date().toISOString();
  const source: Run = { version: 1, id: '6ac6b6d0-a51b-4a93-94c3-f6085a977a84', workflow, workflowUri: 'file:///flow', repositoryUri: 'file:///repo', status: 'failed', createdAt: stamp, updatedAt: stamp, steps: Object.fromEntries(workflow.nodes.map((node, index) => [node.id, index < 2 ? { status: 'succeeded', output: 'Approved' } : index === 2 ? { status: 'failed', previousOutput: 'Already proposed the approved plan' } : { status: 'queued' }])) };
  try {
    const retry = await runner.recover(source, 'retry', { repository: root, frameworkRoot: root, system: '', data: 'fresh memory', validate: async () => {} } as any);
    await runner.wait(retry.id);
    assert.equal(JSON.parse(JSON.parse(received).context).recovery.failedOutput, 'Already proposed the approved plan');
    assert.equal(JSON.parse(received).continuation.previousReport, 'Already proposed the approved plan');
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});
