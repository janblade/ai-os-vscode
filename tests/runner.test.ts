import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Runner, RunStore } from '../src/core/runner';
import { Run, exampleWorkflow } from '../src/contracts';
import { AgentProvider } from '../src/providers/mock';
import { createFile } from '../src/core/files';

const provider: AgentProvider = { id: 'mock', capabilities: { cancellation: true, resume: false, toolApprovals: false }, execute: async () => 'Mock output' };
async function setup() {
  const root = path.resolve('.test-build', `runs-${randomUUID()}`); await mkdir(root, { recursive: true });
  const store = new RunStore(root); const events: Run[] = []; const errors: unknown[] = [];
  const runner = new Runner(store, provider, run => events.push(run), error => errors.push(error));
  return { store, runner, events, errors, close: async () => { await runner.stop(); await rm(root, { recursive: true, force: true }); } };
}
async function until(predicate: () => boolean) {
  for (let tries = 0; tries < 200; tries++) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Timed out waiting for runner state');
}

test('persists transitions before approval and completes only after human decision', async () => {
  const f = await setup();
  try {
    const flow = exampleWorkflow('demo');
    const run = await f.runner.start(flow, 'file:///flow', 'file:///repo', 'file:///task');
    flow.name = 'Changed after dispatch';
    await until(() => f.events.at(-1)?.status === 'waitingApproval');
    assert.equal((await f.store.list())[0].steps.plan.output, 'Mock output');
    assert.equal((await f.store.list())[0].workflow.name, 'Plan and review');
    await assert.rejects(f.runner.start(flow, 'file:///other', 'file:///repo'), /already active/);
    f.runner.approve(run.id); await f.runner.wait(run.id);
    assert.equal((await f.store.list())[0].status, 'succeeded');
    assert.equal(f.events[0].status, 'queued');
    assert.deepEqual(f.errors, []);
  } finally { await f.close(); }
});

test('cancellation at an approval does not execute following steps', async () => {
  const f = await setup();
  try {
    const run = await f.runner.start(exampleWorkflow('demo'), 'file:///flow', 'file:///repo');
    await until(() => f.events.at(-1)?.status === 'waitingApproval');
    f.runner.cancel(run.id); await f.runner.wait(run.id);
    assert.equal((await f.store.list())[0].status, 'cancelled');
    assert.throws(() => f.runner.approve(run.id));
  } finally { await f.close(); }
});

test('restart marks unfinished work interrupted and does not automatically replay it', async () => {
  const f = await setup();
  try {
    const run: Run = { version: 1, id: randomUUID(), workflow: exampleWorkflow('demo'), workflowUri: 'file:///flow', repositoryUri: 'file:///repo', status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), steps: { plan: { status: 'running' }, review: { status: 'queued' } } };
    await f.store.save(run);
    const recovered = await f.store.recover();
    assert.equal(recovered[0].status, 'interrupted'); assert.equal(f.events.length, 0);
    await f.runner.resume(recovered[0]);
    await until(() => f.events.at(-1)?.status === 'waitingApproval');
    f.runner.approve(run.id); await f.runner.wait(run.id);
    assert.equal((await f.store.list())[0].status, 'succeeded');
    assert.equal((await f.store.list())[0].error, undefined);
  } finally { await f.close(); }
});

test('provider failure is persisted without retries', async () => {
  const f = await setup(); let calls = 0;
  const runner = new Runner(f.store, { ...provider, execute: async () => { calls++; throw new Error('Provider failed'); } }, () => {}, error => f.errors.push(error));
  try {
    const run = await runner.start(exampleWorkflow('demo'), 'file:///flow', 'file:///repo'); await runner.wait(run.id);
    const saved = (await f.store.list())[0];
    assert.equal(saved.status, 'failed'); assert.equal(saved.steps.review.status, 'queued'); assert.equal(calls, 1);
  } finally { await runner.stop(); await f.close(); }
});

test('normal shutdown preserves a resumable interruption and ignores damaged sibling snapshots', async () => {
  const f = await setup();
  try {
    const run = await f.runner.start(exampleWorkflow('demo'), 'file:///flow', 'file:///repo');
    await until(() => f.events.at(-1)?.status === 'waitingApproval');
    await f.runner.stop();
    await createFile(f.store.root, 'snapshots/damaged.json', '{broken');
    const recovered = await f.store.recover();
    assert.equal(recovered.length, 1); assert.equal(recovered[0].status, 'interrupted');
    assert.equal(f.store.problems.length, 1);
    await f.runner.resume(recovered[0]);
    await until(() => f.events.at(-1)?.status === 'waitingApproval');
    f.runner.approve(run.id); await f.runner.wait(run.id);
    assert.equal((await f.store.list())[0].status, 'succeeded');
    assert.equal((await f.store.list())[0].error, undefined);
  } finally { await f.close(); }
});

test('cannot dispatch if the pre-execution snapshot cannot be saved', async () => {
  const f = await setup(); let calls = 0;
  class BrokenStore extends RunStore { async save(): Promise<void> { throw new Error('Disk full'); } }
  const runner = new Runner(new BrokenStore(f.store.root), { ...provider, execute: async () => { calls++; return 'Unexpected'; } }, () => {}, () => {});
  try {
    await assert.rejects(runner.start(exampleWorkflow('demo'), 'file:///flow', 'file:///repo'), /Disk full/);
    assert.equal(calls, 0);
  } finally { await runner.stop(); await f.close(); }
});
