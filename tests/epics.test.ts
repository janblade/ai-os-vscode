import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { parseEpic, isEpic } from '../src/framework/epics';
import { parseDashboardMessage } from '../src/dashboard-contracts';
import { parseRun, Runner, RunStore } from '../src/core/runner';
import { exampleWorkflow } from '../src/contracts';
import { MockProvider } from '../src/providers/mock';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { epicText } from './fixtures/epic';
test('epics derive story progress and enforce approval, acceptance, dependency and lowest-ready ordering', () => {
  const epic = parseEpic(epicText); assert.equal(epic.task, '.ai-os/memory/tasks/task.md');
  assert.equal(epic.stories[0].blocked, undefined); assert.match(epic.stories[1].blocked!, /dependencies/);
  assert.equal(epic.completed, 0); assert.equal(epic.total, 2);
  const verified = epicText.replace('Status: approved\n### Acceptance', 'Status: done\n### Acceptance').replace('- [ ] Cause', '- [x] Cause').replace('1. [ ] Inspect', '1. [x] Inspect');
  const advanced = parseEpic(verified); assert.equal(advanced.completed, 1); assert.equal(advanced.derivedStatus, 'in-progress'); assert.equal(advanced.stories[1].blocked, undefined);
  const premature = parseEpic(epicText.replace('Status: approved\n### Acceptance', 'Status: done\n### Acceptance'));
  assert.equal(premature.completed, 0); assert.match(premature.stories[1].blocked!, /dependencies/);
  assert.match(parseEpic(epicText.replace('- Status: approved', '- Status: draft')).stories[0].blocked!, /Approve/);
  assert.match(parseEpic(epicText.replace('depends on: Story 1\n', '')).stories[1].blocked!, /Story 1 runs first/);
});
test('epic parsing preserves stable slugs, ignores fenced examples and rejects unsafe/ambiguous structure', () => {
  assert.equal(parseEpic('\ufeff' + epicText).title, 'Release feature');
  assert.equal(parseEpic(epicText.replace(/ - /g, ' \u2014 ')).stories.length, 2);
  assert.equal(parseEpic(epicText.replace('Investigate evidence', 'Renamed investigation')).stories[0].id, 'investigate');
  assert.equal(isEpic('# Plan: Flat\n## Context\n- Type: epic'), false);
  const example = epicText.replace('Deliver the verified feature safely.', '```markdown\n## Story 99: fake - Example\nStatus: done\n- [x] fake\n```');
  assert.equal(parseEpic(example).stories.length, 2);
  for (const text of [epicText.replace('depends on: Story 1', 'depends on: Story 9'), epicText.replace('implement -', 'investigate -'), epicText.replace('Status: approved\n### Acceptance', 'Status: approved\ndepends on: Story 2\n### Acceptance'), epicText.replace('memory/tasks/task.md', '../outside.md'), epicText.replace('Status: approved\n### Acceptance', 'Status: invalid\n### Acceptance')]) assert.throws(() => parseEpic(text));
  assert.equal(parseDashboardMessage({ type: 'runStory', id: '.ai-os/memory/plans/release.md', revision: 1, storyId: 'investigate', sha256: 'a'.repeat(64) }).type, 'runStory');
  assert.throws(() => parseDashboardMessage({ type: 'runStory', id: 'epic', revision: 1, storyId: '../story', sha256: 'a'.repeat(64) }));
});
test('story run snapshots preserve epic/story identity without changing reusable workflow definitions', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-epic-run-'));
  const store = new RunStore(root); const runner = new Runner(store, new MockProvider(), () => {}, error => { throw error; });
  try {
    const workflow = exampleWorkflow('epic'); const original = JSON.stringify(workflow);
    const story = { epicUri: 'file:///framework/epic.md', id: 'investigate', title: 'Investigation', sha256: 'a'.repeat(64) };
    const context: any = { story, repository: root, frameworkRoot: root, system: '', data: '', validate: async () => {} };
    const run = await runner.start(workflow, 'file:///flow', 'file:///repo', 'file:///task', context);
    for (let count = 0; count < 200 && (await store.list())[0].status !== 'waitingApproval'; count++) await new Promise(resolve => setTimeout(resolve, 10));
    runner.approve(run.id); await runner.wait(run.id);
    const saved = (await store.list())[0]; assert.deepEqual(saved.story, story); assert.equal(JSON.stringify(workflow), original);
    assert.equal(saved.status, 'succeeded');
    await assert.rejects(runner.resume({ ...saved, status: 'interrupted' }), /cannot be replayed/);
    assert.throws(() => parseRun(JSON.stringify({ ...saved, story: { ...story, id: '../unsafe' } })), /story link/);
  } finally { await runner.stop(); await rm(root, { recursive: true, force: true }); }
});
