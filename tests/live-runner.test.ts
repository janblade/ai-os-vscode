import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Runner, RunStore } from '../src/core/runner';
import { Run, exampleWorkflow } from '../src/contracts';
import { ExecutionContext } from '../src/providers/context';
import { AgentProvider } from '../src/providers/mock';

test('live runner persists tool approval/session, isolates duplicate hosts and refuses side-effect replay', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-live-run-')); const events: Run[] = [];
  let allow!: (value: boolean) => void; const answer = new Promise<boolean>(resolve => { allow = resolve; });
  const context: Omit<ExecutionContext, 'runId'> = { repository: root, frameworkRoot: root, system: 'Synthetic rules', data: 'Synthetic task', validate: async () => {}, activity: async () => {}, session: async () => {}, input: async () => 'answer', approval: async () => answer };
  const provider: AgentProvider = { id: 'codex', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (_node, _signal, bound) => {
    assert.ok(bound); await bound.usage?.({inputTokens:10,outputTokens:5}); await bound.usage?.({inputTokens:-1,outputTokens:5}); await bound.session('native-session'); await bound.activity('Inspecting evidence');
    assert.equal(await bound.approval('Edit file?', '{}'), true); return 'Edited with approval';
  } };
  const store = new RunStore(path.join(root, 'runs'));
  const first = new Runner(store, provider, run => events.push(run), () => {}, path.join(root, 'locks'));
  const otherStore = new RunStore(path.join(root, 'other-runs'));
  const second = new Runner(otherStore, provider, () => {}, () => {}, path.join(root, 'locks'));
  try {
    const workflow = exampleWorkflow('native'); workflow.nodes[0].config.provider = 'codex';
    const run = await first.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    for (let count = 0; count < 200 && !events.at(-1)?.steps.plan.toolApproval; count++) await new Promise(resolve => setTimeout(resolve, 10));
    const pending = (await store.list())[0]; assert.equal(pending.status, 'waitingApproval'); assert.equal(pending.steps.plan.providerSessionId, 'native-session');
    assert.throws(() => first.approve(run.id), /not waiting/);
    await assert.rejects(second.start(workflow, 'file:///flow', 'file:///repo', undefined, context), /owns this repository/);
    await assert.rejects(second.resume(pending), /cannot be replayed/);
    allow(true);
    for (let count = 0; count < 200 && events.at(-1)?.steps.review.status !== 'waitingApproval'; count++) await new Promise(resolve => setTimeout(resolve, 10));
    first.approve(run.id); await first.wait(run.id);
    const completed = (await store.list())[0];
    assert.equal(completed.status, 'succeeded');
    assert.deepEqual(completed.steps.plan.usage, {inputTokens:10,outputTokens:5});
    assert.ok(completed.steps.plan.context!.bytes > 0);
    const again = await second.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    second.cancel(again.id); await second.wait(again.id);
    assert.equal((await otherStore.list())[0].status, 'cancelled');
  } finally { allow(true); await first.stop(); await second.stop(); await rm(root, { recursive: true, force: true }); }
});

test('authorization revocation stops a running provider before it can finish another action', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-revoke-'));
  let authorized = true; let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; });
  const store = new RunStore(path.join(root, 'runs'));
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => { if (!authorized) throw new Error('Repository removed'); } };
  const provider: AgentProvider = { id: 'codex', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (_node, signal) => { entered(); await new Promise<void>((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('Stopped')), { once: true })); return 'unreachable'; } };
  const runner = new Runner(store, provider, () => {}, error => { throw error; });
  try {
    const workflow = exampleWorkflow('revoke'); workflow.nodes[0].config.provider = 'codex';
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    await started; authorized = false; await runner.revalidate(); await runner.wait(run.id);
    const saved = (await store.list())[0]; assert.equal(saved.status, 'cancelled'); assert.match(saved.error!, /Authorization changed/);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});

test('uncertain provider shutdown retains the repository lease for explicit inspection', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-shutdown-lease-'));
  const store = new RunStore(path.join(root, 'runs'));
  const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {} };
  const provider: AgentProvider = { id: 'codex', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async () => { throw new Error('Provider shutdown could not be confirmed.'); } };
  const runner = new Runner(store, provider, () => {}, () => {});
  try {
    const workflow = exampleWorkflow('shutdown'); workflow.nodes[0].config.provider = 'codex';
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context); await runner.wait(run.id);
    assert.equal((await store.list())[0].status, 'failed');
    await assert.rejects(runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context), /owns this repository/);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});
