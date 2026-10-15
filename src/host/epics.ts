import * as vscode from 'vscode';
import { WorkspaceBinding, requireTrust } from './binding';
import { listFiles, readText } from '../core/files';
import { parseEpic } from '../framework/epics';
import { readBinding, TaskBinding } from '../framework/tasks';
import { StoryLink } from '../contracts';
export interface StorySelection { file: string; id: string; sha256: string }
export async function storyContext(binding: WorkspaceBinding, selection: StorySelection, task: TaskBinding): Promise<{ link: StoryLink; data: string; validate: () => Promise<void> }> {
  const root = await binding.require();
  if (!/^\.ai-os\/memory\/plans\/[^/]+\.md$/.test(selection.file)) throw new Error('Choose an epic plan.');
  const text = await readText(root.uri.fsPath, selection.file); const epic = parseEpic(text);
  const story = epic.stories.find(story => story.id === selection.id);
  if (epic.sha256 !== selection.sha256 || !story || story.blocked || epic.task !== task.note || task.archived) throw new Error(story?.blocked ?? 'Epic or linked task changed. Refresh before running.');
  const uniqueIdentity = async () => {
    if (!epic.identity) return;
    let count = 0;
    for (const file of await listFiles(root.uri.fsPath, '.ai-os/memory/plans')) if (file.endsWith('.md') && (await readText(root.uri.fsPath, file)).match(/^- Epic-ID:\s*([^\r\n]+)/m)?.[1].trim() === epic.identity) count++;
    if (count !== 1) throw new Error('Duplicate or missing Epic-ID. Resolve it before running.');
  };
  const uri = vscode.Uri.joinPath(root.uri, selection.file);
  const validate = async () => {
    requireTrust(); await uniqueIdentity();
    if ((await binding.require()).uri.toString() !== root.uri.toString()) throw new Error('Framework authorization changed.');
    if (vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString() && document.isDirty)) throw new Error('Save the epic source before running a story.');
    const current = parseEpic(await readText(root.uri.fsPath, selection.file));
    if (current.sha256 !== selection.sha256 || current.stories.find(candidate => candidate.id === selection.id)?.blocked) throw new Error('Epic changed during execution. Review progress before starting another run.');
    await readText(root.uri.fsPath, task.note);
    const currentTask = await readBinding(root.uri.fsPath, task.note);
    if (!currentTask || currentTask.id !== task.id || currentTask.archived || JSON.stringify(currentTask.repository) !== JSON.stringify(task.repository)) throw new Error('Linked task identity or authorization changed.');
  };
  await validate();
  return { link: { ...(epic.identity ? { epicId: epic.identity } : {}), epicUri: uri.toString(), id: story.id, title: story.title, sha256: epic.sha256 }, data: JSON.stringify({ epicFile: selection.file, context: epic.context, story, instruction: 'Work only on this selected story. Follow PLAN_EXECUTE verification, acceptance and review gates. Propose plan updates through the reviewed memory operation. A successful workflow run does not establish story completion.' }), validate };
}
