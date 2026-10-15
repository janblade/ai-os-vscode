import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repositoryReview } from '../src/core/review';
import { reviewedEpic } from '../src/framework/epic-edit';
import { parseEpic } from '../src/framework/epics';
import { appendHandoff } from '../src/framework/handoff';
import { epicText } from './fixtures/epic';
import { parseDashboardMessage } from '../src/dashboard-contracts';
import { Runner, RunStore, parseRun } from '../src/core/runner';
import { MockProvider } from '../src/providers/mock';
import { exampleWorkflow } from '../src/contracts';

test('review fingerprints tracked, staged, untracked content and commits without running repository fsmonitor', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-review-'));
  const git = (...args: string[]) => promisify(execFile)('git', args, { cwd: root, windowsHide: true });
  try {
    await git('init'); await git('config', 'user.name', 'Test'); await git('config', 'user.email', 'test@example.invalid');
    await writeFile(path.join(root, 'tracked.txt'), 'original'); await git('add', '.'); await git('commit', '-m', 'baseline');
    const clean = await repositoryReview(root); assert.equal(clean.diff, '');
    await writeFile(path.join(root, 'tracked.txt'), 'changed'); const tracked = await repositoryReview(root); assert.notEqual(tracked.token, clean.token); assert.match(tracked.diff, /changed/);
    await git('add', '.'); assert.notEqual((await repositoryReview(root)).token, tracked.token);
    await writeFile(path.join(root, 'tracked.txt'), 'staged-one'); await git('add', 'tracked.txt'); await writeFile(path.join(root, 'tracked.txt'), 'changed');
    const indexOne = await repositoryReview(root);
    await writeFile(path.join(root, 'tracked.txt'), 'staged-two'); await git('add', 'tracked.txt'); await writeFile(path.join(root, 'tracked.txt'), 'changed');
    const indexTwo = await repositoryReview(root); assert.equal(indexOne.diff, indexTwo.diff); assert.equal(indexOne.status, indexTwo.status); assert.notEqual(indexOne.token, indexTwo.token); assert.match(indexTwo.stagedDiff, /staged-two/);
    await writeFile(path.join(root, 'new.txt'), 'one'); const untracked = await repositoryReview(root); assert.deepEqual(untracked.untracked, ['new.txt']);
    await writeFile(path.join(root, 'new.txt'), 'two'); assert.notEqual((await repositoryReview(root)).token, untracked.token);
    const beforeTransient = await repositoryReview(root);
    await writeFile(path.join(root, 'host-operation.tmp'), 'pending atomic save');
    assert.equal((await repositoryReview(root, ['host-operation.tmp'])).token, beforeTransient.token, 'Only the current operation excludes its owned untracked temporary file');
    assert.notEqual((await repositoryReview(root)).token, beforeTransient.token, 'Ordinary review includes the temporary file');
    await git('config', 'core.fsmonitor', 'command-that-must-never-run'); await repositoryReview(root);
    await git('commit', '-m', 'change'); assert.notEqual((await repositoryReview(root)).head, clean.head);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('reviewed epic preserves identity, CRLF, story slugs and rejects unchecked completion', () => {
  const initial = epicText.replace(/\n/g, '\r\n'); const saved = reviewedEpic(initial, initial); const epic = parseEpic(saved);
  assert.match(epic.identity!, /^[a-f0-9-]{36}$/); assert.ok(saved.includes('\r\n')); assert.equal(reviewedEpic(saved, saved), saved);
  assert.throws(() => reviewedEpic(saved, saved.replace(epic.identity!, 'a'.repeat(36))), /Preserve/);
  assert.throws(() => reviewedEpic(saved, saved.replace('investigate -', 'other -')), /Preserve/);
  assert.throws(() => reviewedEpic(initial, initial.replace('Status: approved\r\n### Acceptance', 'Status: done\r\n### Acceptance')), /completed steps/);
  const done = initial.replace('Status: approved\r\n### Acceptance', 'Status: done\r\n### Acceptance').replace('- [ ] Cause', '- [x] Cause').replace('1. [ ] Inspect', '1. [x] Inspect');
  assert.equal(parseEpic(reviewedEpic(initial, done)).status, 'in-progress');
});
test('handoffs preserve previous notes and identity and require explicit verification disclosure', () => {
  const before = '# Task\nTask-ID: unchanged\n## Working notes\nOld evidence';
  const handoff = { nextStep: 'Inspect API', findings: 'Observed failure', unknowns: 'Service unavailable', verification: 'Not reproduced; reviewed logs only' };
  const once = appendHandoff(before, handoff, '2026-10-14T12:00:00Z');
  assert.ok(once.startsWith(before)); assert.match(once, /Not reproduced/);
  assert.equal(appendHandoff(once, handoff, 'later').split('## Dashboard handoff').length, 3);
  assert.throws(() => appendHandoff(before, { ...handoff, verification: '' }, 'now'));
  assert.throws(() => parseDashboardMessage({ type: 'acceptRun', id: 'run:id', revision: 1, token: 'a'.repeat(64), verification: 'test', findings: 'accepted' }));
  assert.throws(() => parseDashboardMessage({ type: 'recordHandoff', id: 'task', revision: 1, token: 'a'.repeat(64), ...handoff, approval: true }));
});
test('human review is persisted independently from execution and cannot accept an active run', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-receipt-')); const store = new RunStore(root);
  const runner = new Runner(store, new MockProvider(), () => {}, error => { throw error; });
  try {
    const run = await runner.start(exampleWorkflow('review'), 'file:///flow', 'file:///repo');
    const review = { acceptedAt: new Date().toISOString(), repositoryToken: 'a'.repeat(64), verification: 'Tests passed', findings: 'Reviewed accepted scope' };
    await assert.rejects(runner.recordReview(run, review), /Finish or cancel/);
    runner.cancel(run.id); await runner.wait(run.id); const saved = (await store.list())[0];
    await runner.recordReview(saved, review); const accepted = (await store.list())[0]; assert.deepEqual(accepted.review, review); assert.equal(accepted.status, 'cancelled');
    assert.throws(() => parseRun(JSON.stringify({ ...accepted, review: { ...review, verification: '' } })), /review receipt/);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});

test('live assistant output and activity trail persist before completion with bounded history', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-live-output-')); const store = new RunStore(root);
  const provider = { id: 'stream-fixture', capabilities: { cancellation: true, resume: false, toolApprovals: true }, execute: async (_node: any, _signal: AbortSignal, context: any) => {
    for (let index = 0; index < 35; index++) await context.activity(`Observed step ${index}`);
    await context.output('Visible partial response'); return 'Final response';
  } };
  const snapshots: any[] = []; const runner = new Runner(store, provider, run => snapshots.push(run), error => { throw error; });
  try {
    const workflow = exampleWorkflow('stream');
    const context: any = { repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {} };
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', undefined, context);
    for (let count = 0; count < 200 && !snapshots.some(run => run.status === 'waitingApproval'); count++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(snapshots.some(run => run.steps.plan.status === 'running' && run.steps.plan.liveOutput === 'Visible partial response'));
    const saved = (await store.list())[0]; assert.equal(saved.steps.plan.events!.length, 30); assert.equal(saved.steps.plan.events![0].summary, 'Observed step 5');
    assert.throws(() => parseRun(JSON.stringify({ ...saved, steps: { ...saved.steps, plan: { ...saved.steps.plan, events: [{ at: 'invalid', summary: 'x' }] } } })), /activity trail/);
    runner.cancel(run.id); await runner.wait(run.id);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});


test('review fingerprints embedded untracked Git repositories instead of rejecting Git directory entries', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-nested-review-'));
  const git = async (cwd: string, ...args: string[]) => promisify(execFile)('git', args, { cwd, windowsHide: true });
  const init = async (cwd: string) => { await git(cwd, 'init'); await git(cwd, 'config', 'user.email', 'fixture@example.invalid'); await git(cwd, 'config', 'user.name', 'Fixture'); await git(cwd, 'config', 'commit.gpgsign', 'false'); await writeFile(path.join(cwd, 'tracked.txt'), 'initial'); await git(cwd, 'add', '.'); await git(cwd, 'commit', '-m', 'fixture'); };
  try {
    await init(root); const packageFolder = path.join(root, 'package'); await mkdir(packageFolder); await repositoryReview(packageFolder);
    const nested = path.join(root, 'vendor'); await mkdir(nested); await init(nested);
    const first = await repositoryReview(root); assert.deepEqual(first.untracked, ['vendor/']); assert.match(first.diff, /Nested repository: vendor/);
    await writeFile(path.join(nested, 'tracked.txt'), 'modified dependency'); const changed = await repositoryReview(root);
    assert.notEqual(changed.token, first.token); assert.match(changed.diff, /modified dependency/);
    await writeFile(path.join(nested, 'new.txt'), 'one'); const untracked = await repositoryReview(root);
    await writeFile(path.join(nested, 'new.txt'), 'two'); assert.notEqual((await repositoryReview(root)).token, untracked.token);
    await git(nested, 'add', '.'); await git(nested, 'commit', '-m', 'dependency update'); assert.notEqual((await repositoryReview(root)).token, first.token);
  } finally { await rm(root, { recursive: true, force: true }); }
});
