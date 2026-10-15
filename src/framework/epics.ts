import { createHash } from 'node:crypto';
import { validateRelativePath } from '../core/files';
export type PlanStatus = 'draft' | 'approved' | 'in-progress' | 'done' | 'abandoned';
export interface EpicStory { run?: { id: string; status: string; active?: boolean }; id: string; number: number; title: string; status: PlanStatus; dependencies: number[]; steps: { done: number; total: number }; acceptance: { done: number; total: number }; content: string; blocked?: string }
export interface EpicPlan { identity?: string; derivedStatus: PlanStatus; title: string; status: PlanStatus; task?: string; sha256: string; stories: EpicStory[]; completed: number; total: number; context: string }
const statuses = ['draft', 'approved', 'in-progress', 'done', 'abandoned'];
function status(value: string | undefined): PlanStatus { if (!value || !statuses.includes(value)) throw new Error('Invalid or missing plan/story status.'); return value as PlanStatus; }
/** Keep code examples inert when recognizing plan structure and checkboxes. */
export function structuralLines(text: string): string[] {
  let fence: string | undefined;
  return text.replace(/^\uFEFF/, '').split(/\r?\n/).map(line => {
    const marker = line.match(/^\s{0,3}(`{3,}|~{3,})/);
    if (marker) { if (!fence) fence = marker[1]; else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = undefined; return ''; }
    return fence ? '' : line;
  });
}
export function isEpic(text: string): boolean { const lines = structuralLines(text); const end = lines.findIndex(line => /^## /.test(line)); return lines.slice(0, end < 0 ? lines.length : end).some(line => /^- Type:\s*epic\s*(?:#.*)?$/i.test(line)); }
export function parseEpic(text: string): EpicPlan {
  if (!isEpic(text)) throw new Error('This plan is not Type: epic.');
  const lines = structuralLines(text); const original = text.split(/\r?\n/);
  const heads: { start: number; number: number; id: string; title: string }[] = [];
  for (const [start, line] of lines.entries()) {
    if (!/^## Story\b/.test(line)) continue;
    const match = line.match(/^## Story ([1-9][0-9]*): ([a-z0-9][a-z0-9-]{0,99})\s+(?:\u2014|\u2013|-)\s+(.+)$/);
    if (!match) throw new Error('Use Story N: kebab-slug followed by a dash and title.');
    if (!match[3].trim() || match[3].length > 1000 || !Number.isSafeInteger(Number(match[1]))) throw new Error('Invalid story heading.');
    heads.push({ start, number: Number(match[1]), id: match[2], title: match[3] });
  }
  if (!heads.length || heads.length > 100 || new Set(heads.map(head => head.id)).size !== heads.length || new Set(heads.map(head => head.number)).size !== heads.length) throw new Error('Epic needs 1-100 stories with unique numbers and slugs.');
  const header = lines.slice(0, heads[0].start).join('\n');
  const metadata = lines.slice(0, lines.findIndex(line => /^## /.test(line))).join('\n');
  const field = (name: string) => { const values = [...metadata.matchAll(new RegExp(`^- ${name}:\\s*([^\\n#]+)`, 'gm'))]; if (values.length > 1) throw new Error('Duplicate epic metadata.'); return values[0]?.[1].trim(); };
  if (field('Type')?.toLowerCase() !== 'epic') throw new Error('Invalid epic type.');
  const taskField = field('Task file'); let task: string | undefined;
  if (taskField) { task = taskField.startsWith('.ai-os/') ? taskField : `.ai-os/${taskField}`; validateRelativePath(task); if (!/^\.ai-os\/memory\/tasks\/[^/]+\.md$/.test(task)) throw new Error('Epic task must be a working task note.'); }
  const identity = field('Epic-ID');
  if (identity && !/^[a-f0-9-]{36}$/.test(identity)) throw new Error('Invalid Epic-ID.');
  const epicStatus = status(field('Status'));
  const stories: EpicStory[] = heads.map((head, index) => {
    const end = heads[index + 1]?.start ?? lines.length;
    const body = lines.slice(head.start + 1, end); const bodyText = body.join('\n');
    if ([...bodyText.matchAll(/^Status:/gm)].length !== 1 || [...bodyText.matchAll(/^depends on:/gmi)].length > 1) throw new Error('Ambiguous story metadata.');
    const storyStatus = status(bodyText.match(/^Status:\s*([^\n#]+)/m)?.[1].trim());
    const dependencyLine = bodyText.match(/^depends on:\s*([^\n#]+)/mi)?.[1].trim();
    let dependencies: number[] = [];
    if (dependencyLine) {
      if (!/^Story [1-9][0-9]*(?:\s*,\s*Story [1-9][0-9]*)*$/.test(dependencyLine)) throw new Error('Dependencies must name Story N, separated by commas.');
      dependencies = [...dependencyLine.matchAll(/Story ([0-9]+)/g)].map(match => Number(match[1]));
    }
    const steps = { done: 0, total: 0 }, acceptance = { done: 0, total: 0 }; let section = '';
    for (const line of body) {
      const heading = line.match(/^#{2,3} (.+)/); if (heading) section = heading[1].toLowerCase();
      const box = line.match(/^\s*(?:[-*]|[0-9]+[.)]) \[([ xX])\]/);
      if (!box) continue;
      const counts = section === 'steps' ? steps : section === 'acceptance criteria' ? acceptance : undefined;
      if (counts) { counts.total++; if (box[1].toLowerCase() === 'x') counts.done++; }
    }
    return { id: head.id, number: head.number, title: head.title, status: storyStatus, dependencies, steps, acceptance, content: original.slice(head.start, end).join('\n') };
  });
  for (const story of stories) if (story.dependencies.some(number => number === story.number || !stories.some(candidate => candidate.number === number))) throw new Error('Story dependency is missing or references itself.');
  const visited = new Map<number, number>();
  const visit = (story: EpicStory) => {
    if (visited.get(story.number) === 1) throw new Error('Cyclic story dependencies.');
    if (visited.get(story.number) === 2) return;
    visited.set(story.number, 1);
    for (const number of story.dependencies) visit(stories.find(candidate => candidate.number === number)!);
    visited.set(story.number, 2);
  };
  for (const story of stories) visit(story);
  for (const story of stories) {
    if (!story.steps.total || !story.acceptance.total) story.blocked = 'Add steps and acceptance criteria before execution.';
    else if (story.status === 'done' && (story.steps.done !== story.steps.total || story.acceptance.done !== story.acceptance.total)) story.blocked = 'Done status conflicts with unchecked steps or acceptance criteria.';
    else if (['done', 'abandoned'].includes(story.status)) story.blocked = `Story is ${story.status}.`;
    else if (!['approved', 'in-progress'].includes(epicStatus) || !['approved', 'in-progress'].includes(story.status)) story.blocked = 'Approve the epic and story before execution.';
    else if (story.dependencies.some(number => { const dependency = stories.find(candidate => candidate.number === number)!; return dependency.status !== 'done' || !dependency.steps.total || !dependency.acceptance.total || dependency.steps.done !== dependency.steps.total || dependency.acceptance.done !== dependency.acceptance.total; })) story.blocked = 'Waiting for dependencies to be marked done with completed steps and acceptance criteria.';
  }
  const next = stories.filter(story => !story.blocked).sort((a, b) => a.number - b.number)[0];
  for (const story of stories) if (!story.blocked && story !== next) story.blocked = `Story ${next.number} runs first under PLAN_EXECUTE ordering.`;
  const completed = stories.filter(story => story.status === 'done' && story.steps.total > 0 && story.acceptance.total > 0 && story.steps.done === story.steps.total && story.acceptance.done === story.acceptance.total).length;
  const derivedStatus = ['draft', 'abandoned'].includes(epicStatus) ? epicStatus : completed === stories.length ? 'done' : stories.every(story => ['done', 'abandoned'].includes(story.status)) && stories.some(story => story.status === 'abandoned') ? 'abandoned' : stories.some(story => story.status === 'in-progress' || story.status === 'done' || story.steps.done || story.acceptance.done) ? 'in-progress' : 'approved';
  return { identity, derivedStatus, title: header.match(/^# (?:Epic|Plan): (.+)$/m)?.[1] ?? 'Epic plan', status: epicStatus, task, sha256: createHash('sha256').update(text).digest('hex'), stories, completed, total: stories.length, context: original.slice(0, heads[0].start).join('\n') };
}
