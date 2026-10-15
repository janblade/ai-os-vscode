import { randomUUID } from 'node:crypto';
import { parseEpic, structuralLines } from './epics';
/** Preserve established identities and derive the header from the reviewed story state. */
export function reviewedEpic(original: string, draft: string): string {
  if (Buffer.byteLength(draft) > 256000) throw new Error('Epic exceeds 256 KB.');
  const before = parseEpic(original); const after = parseEpic(draft);
  if (before.identity !== after.identity || before.task !== after.task || before.stories.some(story => !after.stories.some(next => next.id === story.id))) throw new Error('Preserve Epic-ID, linked task and existing story slugs. Retire stories as abandoned instead of deleting them.');
  for (const story of after.stories) {
    if (story.status === 'done' && (!story.steps.total || !story.acceptance.total || story.steps.done !== story.steps.total || story.acceptance.done !== story.acceptance.total)) throw new Error('Done stories require completed steps and acceptance criteria.');
    if (story.status === 'done' && story.dependencies.some(number => after.stories.find(candidate => candidate.number === number)!.status !== 'done')) throw new Error('Complete dependencies before marking a story done.');
  }
  const newline = draft.includes('\r\n') ? '\r\n' : '\n'; const lines = draft.split(/\r?\n/); const structure = structuralLines(draft);
  const status = structure.findIndex(line => /^- Status:/.test(line));
  lines[status] = `- Status: ${after.derivedStatus}`;
  if (!before.identity) lines.splice(structure.findIndex(line => /^- Type:/i.test(line)) + 1, 0, `- Epic-ID: ${randomUUID()}`);
  const result = lines.join(newline); parseEpic(result); return result;
}
