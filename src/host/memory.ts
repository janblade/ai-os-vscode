import { confirmation } from './confirmation';
import * as vscode from 'vscode';
import path from 'node:path';
import { WorkspaceBinding, requireTrust } from './binding';
import { pickRepository } from './workspace';
import { resolveRepository } from '../framework/workspace';
import { workspacePaths } from './binding';
import { readText } from '../core/files';
import { parseProposal, verifyProposal, applyProposal, proposalState } from '../framework/memory-proposal';
export async function reviewMemory(binding: WorkspaceBinding, proposalFile?: string, repositoryUri?: string): Promise<void> {
  requireTrust(); const root = await binding.require();
  const selected = proposalFile ? [vscode.Uri.joinPath(root.uri, proposalFile)] : await vscode.window.showOpenDialog({ defaultUri: vscode.Uri.joinPath(root.uri, '.ai-os/memory/proposals'), canSelectMany: false, filters: { 'Memory proposal': ['json'] } });
  if (!selected?.length) return;
  const relative = path.relative(root.uri.fsPath, selected[0].fsPath).split(path.sep).join('/');
  if (selected[0].scheme !== 'file' || !relative.startsWith('.ai-os/memory/proposals/')) throw new Error('Choose a proposal in this framework.');
  const raw = await readText(root.uri.fsPath, relative); const proposal = parseProposal(raw);
  const target = repositoryUri ? undefined : await pickRepository(); if (!repositoryUri && !target) return;
  const repository = repositoryUri ? vscode.Uri.parse(repositoryUri).fsPath : await resolveRepository(root.uri.fsPath, target!, workspacePaths());
  const validate = async () => {
    requireTrust(); if ((await binding.require()).uri.toString() !== root.uri.toString()) throw new Error('Framework authorization changed.');
    await binding.validateRunTarget(vscode.Uri.file(repository).toString());
    if (await readText(root.uri.fsPath, relative) !== raw) throw new Error('Proposal changed during review.');
    if (vscode.workspace.textDocuments.some(doc => doc.uri.toString() === vscode.Uri.joinPath(root.uri, proposal.target).toString() && doc.isDirty)) throw new Error('Memory has unsaved editor changes.');
  };
  await validate();
  if (await proposalState(root.uri.fsPath, proposal) === 'applied') { void vscode.window.showInformationMessage('This proposal is already applied. No memory changes or new receipt are needed.'); return; }
  const original = await verifyProposal(root.uri.fsPath, repository, proposal);
  const detail = `Target: ${proposal.target}\n\nReason: ${proposal.reason}\n\nEvidence: ${JSON.stringify(proposal.evidence, null, 2)}\n\nCurrent\n${original ?? '(new file)'}\n\nProposed\n${proposal.content}\n\nConfirm the evidence was verified against current code, the underlying work was accepted, and the proposed truth is correct and deduplicated. Approval of a native tool is not memory acceptance.`;
  if (await confirmation.show('Approve this memory proposal?', { detail }, 'Approve proposal') !== 'Approve proposal') return;
  await applyProposal(root.uri.fsPath, repository, proposal, validate);
  void vscode.window.showInformationMessage('Reviewed memory amendment saved.');
}
