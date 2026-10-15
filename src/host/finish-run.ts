import * as vscode from 'vscode';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Run, parseWorkflow } from '../contracts';
import { FinishAction, finalizationPrompt } from '../core/run-finish';
import { repositoryReview } from '../core/review';
import { Runner } from '../core/runner';
import { readText } from '../core/files';
import { readBinding } from '../framework/tasks';
import { resolveAgents } from '../framework/agents';
import { resolveRepository } from '../framework/workspace';
import { WorkspaceBinding, requireTrust, workspacePaths } from './binding';
import { ContextPreviews } from './context';
import { executionContext, trackWorkflow } from './execution';

export async function finishRun(runner: Runner, binding: WorkspaceBinding, previews: ContextPreviews, history: () => Run[], requested: Run, mode: FinishAction, reason: string, nodeIds: string[]): Promise<Run | undefined> {
  requireTrust();
  const source = history().find(run => run.id === requested.id);
  if (!source || source.story) throw new Error('Use the linked epic to finish story work.');
  if (mode === 'skip') { await runner.skipOptional(source.id, nodeIds, reason); return; }
  if (!source.taskUri) throw new Error('Select a bound task before wrapping up or requesting closure.');
  const root = await binding.workflowRoot(vscode.Uri.parse(source.workflowUri));
  const note = path.relative(root.uri.fsPath, vscode.Uri.parse(source.taskUri).fsPath).split(path.sep).join('/');
  const task = await readBinding(root.uri.fsPath, note);
  if (!task || task.id !== source.taskId || task.archived || task.status === 'done') throw new Error('Select an open bound task.');
  if (vscode.Uri.file(await resolveRepository(root.uri.fsPath, task.repository, workspacePaths())).toString() !== source.repositoryUri) throw new Error('Task repository changed.');
  const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(source.workflowUri));
  const currentWorkflow = await resolveAgents(root.uri.fsPath, parseWorkflow(document.getText()), task.agentId);
  const agent = [...currentWorkflow.nodes].reverse().find(node => node.kind === 'agent' && node.config.provider !== 'mock' && !node.config.readOnly);
  if (!agent) throw new Error('This workflow has no writable native agent. Use an AI OS host chat for WRAP or TASK_CLOSE.');
  if (!source.finalization && JSON.stringify(currentWorkflow) !== JSON.stringify(source.workflow)) throw new Error('Workflow or agent configuration changed. Start a fresh workflow before finalization.');
  if (mode === 'close') {
    if (runner.isActive(source.id)) throw new Error('Stop the run and review the current repository changes before requesting task closure.');
    if (!source.review || (await repositoryReview(vscode.Uri.parse(source.repositoryUri).fsPath)).token !== source.review.repositoryToken) throw new Error('Review and accept the current repository changes before requesting task closure.');
  }
  const context = await executionContext(binding, previews, task, task.repository);
  trackWorkflow(context, document, currentWorkflow, task);
  const command = mode === 'wrap' ? 'WRAP' : 'TASK_CLOSE';
  const skillFile = '.ai-os/registry/core.memory.sk/SKILL.md';
  const memorySkill = command === 'TASK_CLOSE' ? await readText(root.uri.fsPath, skillFile) : undefined;
  let launching = true;
  const validate = context.validate;
  context.validate = async () => {
    await validate();
    if (mode === 'close' && launching && (await repositoryReview(context.repository)).token !== source.review!.repositoryToken) throw new Error('Repository changed during closure preparation. Review and accept it again.');
    if (memorySkill !== undefined && await readText(root.uri.fsPath, skillFile) !== memorySkill) throw new Error('Memory lifecycle procedure changed. Request closure again.');
  };
  context.beforeExecute = async () => { await context.validate(); launching = false; };
  const contextSources = context.contextSources;
  if (memorySkill !== undefined) context.contextSources = () => [...(contextSources?.() ?? []),{source:skillFile,sha256:createHash('sha256').update(memorySkill).digest('hex')}];
  if (memorySkill !== undefined) context.system += `\n\nRegistered memory lifecycle procedure:\n${memorySkill}`;
  await context.validate();
  if (runner.isActive(source.id)) { runner.cancel(source.id); await runner.wait(source.id); }
  const stopped = history().find(run => run.id === source.id)!;
  if (stopped.error?.includes('shutdown could not be confirmed')) throw new Error('Native agent shutdown could not be confirmed. Do not start a second agent.');
  await context.validate(); await context.checkMemory?.();
  const priorRunId = source.finalization?.fromRunId ?? source.id;
  const origin = history().find(run=>run.id===priorRunId);
  const originalPhases = origin?.workflow.nodes.map(node=>({id:node.id,label:node.label,status:origin.steps[node.id].status,skipReason:origin.steps[node.id].skipReason}));
  const finishRequest = { command, reason, priorRunId, previousRunId: source.id, originalPhases, priorStatus: stopped.status, phases: stopped.workflow.nodes.map(node => ({ id: node.id, label: node.label, status: stopped.steps[node.id].status, skipReason: stopped.steps[node.id].skipReason, result: (stopped.steps[node.id].output ?? stopped.steps[node.id].previousOutput)?.slice(0,2000), latestUpdate: stopped.steps[node.id].liveOutput?.slice(-1000), providerSessionId: stopped.steps[node.id].providerSessionId })) };
  const withRequest = (data:string) => JSON.stringify({context:data,finishRequest});
  context.data = withRequest(context.data);
  const refreshMemory = context.refreshMemory;
  if (refreshMemory) context.refreshMemory = async () => withRequest(await refreshMemory());
  const workflow = parseWorkflow(JSON.stringify({ version: 1, id: `finish-${command.toLowerCase()}`, name: command === 'WRAP' ? 'Wrap up and save handoff' : 'Request AI OS task closure', nodes: [{ ...agent, id: 'finalize', label: command, config: { ...agent.config, optional: false, finalizationCommand: command, finalizationSessionId: priorRunId, requireVerification: true, prompt: finalizationPrompt(command) } }], edges: [] }));
  // The source remains watched; the generated command and its provenance live in the run snapshot.
  if (mode === 'close' && (await repositoryReview(context.repository)).token !== source.review!.repositoryToken) throw new Error('Repository changed during closure preparation. Review and accept it again.');
  return runner.start(workflow, source.workflowUri, source.repositoryUri, source.taskUri, context, undefined, stopped.guidance, { fromRunId: priorRunId, command, reason });
}
