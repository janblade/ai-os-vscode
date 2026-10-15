import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { prepareTask, parseTaskDraft } from '../src/framework/task-draft';
import { ExecutionContext } from '../src/providers/context';
import { AgentProvider } from '../src/providers/mock';
const result = { title: 'Ticket bug', summary: 'Expected behavior', evidence: 'Reported by user; not reproduced.', scope: 'Selected repository', acceptanceCriteria: 'Reported behavior works', nextSteps: 'Inspect supplied evidence', unknowns: 'Root cause unknown' };
test('prompt and form drafting produce the same validated task sections without side effects', async () => {
  const context: ExecutionContext = { runId: 'draft', repository: 'repo', frameworkRoot: 'framework', system: 'Rules', data: '', validate: async () => {}, activity: async () => {}, session: async () => {}, approval: async () => { assert.fail('No tool approvals'); }, input: async () => { assert.fail('No interactive tools'); } };
  const provider: AgentProvider = { id: 'fake', capabilities: { cancellation: true, resume: false, toolApprovals: false }, execute: async (_node, _signal, bound) => {
    assert.equal(bound?.readOnly, true); assert.equal(await bound!.approval('Write?', ''), false);
    assert.ok(JSON.parse(bound!.data).description); return JSON.stringify(result);
  } };
  const prompt = await prepareTask(provider, context, { description: 'Fix this reported bug', provider: 'codex' }, new AbortController().signal);
  const form = await prepareTask(provider, context, { description: 'Reported evidence', title: 'Ticket bug', provider: 'claude' }, new AbortController().signal);
  assert.deepEqual(prompt, form);
  for (const providerId of ['gemini', 'copilot'] as const) assert.deepEqual(await prepareTask(provider, context, { description: 'Reported evidence', provider: providerId }, new AbortController().signal), prompt);
  for (const heading of ['Summary', 'Evidence', 'Scope', 'Acceptance criteria', 'Next steps', 'Unknowns']) assert.ok(prompt.notes.includes('### ' + heading));
  assert.deepEqual(parseTaskDraft('```json\n' + JSON.stringify(result) + '\n```'), prompt);
  for (const invalid of [{ ...result, repository: '../outside' }, { ...result, title: 'Title\nMore' }, { ...result, summary: '' }, { ...result, evidence: ['Unvalidated type'] }]) assert.throws(() => parseTaskDraft(JSON.stringify(invalid)));
  assert.throws(() => parseTaskDraft('Model prose instead of JSON'));
  const stopped = new AbortController(); stopped.abort(); await assert.rejects(prepareTask(provider, context, { description: 'Bug', provider: 'codex' }, stopped.signal));
});
