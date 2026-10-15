import path from 'node:path';
import { validateEditPath } from './boundaries';
import { ToolApprovalRequest } from './context';

/** Automatic consent covers bounded repository edits only, never shell or expanded permissions. */
export async function automaticEditEligible(repository: string, framework: string, archetype: string, request: ToolApprovalRequest | undefined): Promise<boolean> {
  if (!['hobby', 'startup'].includes(archetype) || request?.kind !== 'fileEdit' || !['create', 'update'].includes(request.operation ?? '') || !Array.isArray(request.paths) || !request.paths.length || request.paths.length > 100) return false;
  try {
    for (const file of request.paths) {
      if (typeof file !== 'string' || !file || file.length > 4000) return false;
      const target = path.resolve(repository, file);
      const relative = path.relative(repository, target);
      if (!relative || path.isAbsolute(relative) || relative.split(path.sep).some(part => part.startsWith('.') || /^(AGENTS|CLAUDE|GEMINI)\.md$/i.test(part))) return false;
      await validateEditPath(repository, framework, target);
    }
    return true;
  } catch { return false; }
}

export function automaticPolicyAllows(archetype: string, definition: unknown): boolean {
  if (!['hobby', 'startup'].includes(archetype) || !definition || typeof definition !== 'object') return false;
  const value = definition as { governance?: {human_approval?: string; code_review?: string}; rule_overrides?: {R15?: string} };
  return ['never', 'destructive-only'].includes(value.governance?.human_approval ?? '')
    && ['none', 'high-risk-only'].includes(value.governance?.code_review ?? '')
    && ['disabled', 'production-deploys-only'].includes(value.rule_overrides?.R15 ?? '');
}
