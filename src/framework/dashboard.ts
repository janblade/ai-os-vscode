import { parseProposal, proposalInventory } from './memory-proposal';
import { taskSummary } from '../core/task-ux';
import path from 'node:path';
import { isEpic, parseEpic } from './epics';
import { agentEntries } from './agents';
import { lstat } from 'node:fs/promises';
import { listFiles, readText, missing, safePath } from '../core/files';
import { taskEntries, sidecar } from './tasks';
import { DashboardEntry } from '../dashboard-contracts';
import { resolveRepository } from './workspace';

export async function dashboardEntries(root: string, folders: string[]): Promise<DashboardEntry[]> {
  const entries: DashboardEntry[] = [];
  for (const task of await taskEntries(root)) {
    let problem = task.error;
    let repository: string | undefined;
    if (task.binding) {
      try { repository = await resolveRepository(root, task.binding.repository, folders); }
      catch (error) { problem = String(error); }
    }
    entries.push({ id: task.note, title: task.binding?.title ?? path.basename(task.note, '.md'), kind: 'task', category: 'Working tasks',
      taskId: task.binding?.id, archived: task.binding?.archived ?? task.note.startsWith('.ai-os/memory/archived_tasks/'),
      agentId: task.binding?.agentId,
      status: task.error ? 'invalid' : task.binding?.status ?? 'unbound', repository,
      properties: task.binding || task.error ? sidecar(task.note) : undefined, problem });
  }
  for (const entry of await agentEntries(root)) entries.push({ id: entry.file, title: entry.agent?.name ?? path.basename(entry.file), kind: 'agent', template: entry.template, category: entry.template ? 'Agent templates' : entry.legacy ? 'Legacy agent profiles' : 'Registered agents', problem: entry.problem });
  const proposals = new Map((await proposalInventory(root)).map(entry => [entry.file, entry]));
  const groups = [
    ['Semantic', '.ai-os/memory/semantic'], ['Semantic', '.ai-os/memory/semantic/knowledge'],
    ['Plans', '.ai-os/memory/plans'], ['Procedural', '.ai-os/memory/procedural'],
    ['Episodic', '.ai-os/memory/episodic'], ['Memory proposals', '.ai-os/memory/proposals'],
    ['Workflows', '.ai-os/workflows'],
  ];
  for (const [category, directory] of groups) {
    for (const file of await listFiles(root, directory)) {
      if (!/\.(md|json|jsonl)$/.test(file)) continue;
      if (category === 'Plans' && file.endsWith('.md')) {
        const text = await readText(root, file);
        if (isEpic(text)) {
          try { const epic = parseEpic(text); entries.push({ id: file, title: epic.title, kind: 'epic', category: 'Epic plans', epic }); }
          catch (error) { entries.push({ id: file, title: path.basename(file), kind: 'epic', category: 'Epic plans', problem: String(error) }); }
          continue;
        }
      }
      if (category === 'Memory proposals') {
        try {
          const proposal = parseProposal(await readText(root, file));
          const lifecycle = proposals.get(file);
          if (lifecycle && lifecycle.state !== 'pending') { entries.push({ id: file, title: path.basename(file), kind: 'memory', category: 'Resolved proposals', subtitle: lifecycle.state + (lifecycle.canonical ? ` - see ${lifecycle.canonical}` : '') }); continue; }
          entries.push({ id: file, title: path.basename(file), kind: 'memory', category, proposal: { target: proposal.target, reason: proposal.reason } });
        } catch { entries.push({ id: file, title: path.basename(file), kind: 'memory', category: 'Proposal support files' }); }
        continue;
      }
      entries.push({ id: file, title: path.basename(file), kind: category === 'Workflows' ? 'workflow' : 'memory', category });
    }
  }
  for (const file of ['AGENTS.md', 'CLAUDE.md', '.ai-os/BOOT.md']) {
    try { if ((await lstat(await safePath(root, file))).isFile()) entries.push({ id: file, title: path.basename(file), kind: 'memory', category: 'Instructions' }); }
    catch (error) { if (!missing(error)) throw error; }
  }
  for (const entry of entries.filter(entry => entry.epic?.identity)) if (entries.filter(candidate => candidate.epic?.identity === entry.epic!.identity).length !== 1) entry.problem = 'Duplicate Epic-ID. Resolve the duplicate before editing or running.';
  for (const entry of entries.filter(entry => entry.kind === 'task')) {
    const content = await readText(root, entry.id);
    Object.assign(entry, taskSummary(content));
    const times = [(await lstat(await safePath(root, entry.id))).mtimeMs];
    if (entry.properties) { try { times.push((await lstat(await safePath(root, entry.properties))).mtimeMs); } catch (error) { if (!missing(error)) throw error; } }
    entry.updatedAt = new Date(Math.max(...times)).toISOString();
    entry.handoff = content.includes('## Dashboard handoff - ');
    const pointer = content.match(/^Active plan:\s*(?:\.ai-os\/)?(memory\/plans\/[^\s]+\.md)(?:\s|$)/m)?.[1];
    if (pointer) entry.plan = `.ai-os/${pointer}`;
    if (pointer && !entries.some(candidate => candidate.id === entry.plan)) {
      const candidates = entries.filter(candidate => candidate.epic?.task === entry.id && !candidate.problem);
      if (candidates.length === 1) { entry.plan = candidates[0].id; entry.planStale = true; }
    }
  }
  for (const entry of entries.filter(entry => entry.kind !== 'task')) {
    try { entry.updatedAt = (await lstat(await safePath(root, entry.id))).mtime.toISOString(); } catch (error) { if (!missing(error)) throw error; }
  }
  return entries;
}
export async function dashboardContent(root: string, entry: DashboardEntry): Promise<string> {
  return readText(root, entry.id);
}
