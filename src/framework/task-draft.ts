import { NativeProviderId } from '../contracts';
import { object } from '../contracts';
import { AgentProvider } from '../providers/mock';
import { ExecutionContext } from '../providers/context';

const sections = { summary: 'Summary', evidence: 'Evidence', scope: 'Scope', acceptanceCriteria: 'Acceptance criteria', nextSteps: 'Next steps', unknowns: 'Unknowns' };
export interface PreparedTask { id: string; title: string; notes: string; repository: number }
export function parseTaskDraft(text: string): { title: string; notes: string } {
  if (typeof text !== 'string' || text.length > 32000) throw new Error('Task draft exceeds the output limit.');
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'))); }
  catch { throw new Error('Agent returned an invalid task draft. Try again; your input is preserved.'); }
  if (Object.keys(value).length !== 7 || Object.keys(value).some(key => !['title', ...Object.keys(sections)].includes(key))
    || typeof value.title !== 'string' || !value.title.trim() || value.title.length > 200 || /[\r\n]/.test(value.title)) throw new Error('Agent returned an invalid task draft. Try again; your input is preserved.');
  const notes = Object.entries(sections).map(([key, label]) => {
    const content = value[key];
    if (typeof content !== 'string' || !content.trim() || content.length > 5000) throw new Error('Agent returned incomplete task sections. Try again; your input is preserved.');
    return `### ${label}\n\n${content.trim()}`;
  }).join('\n\n');
  return { title: value.title.trim(), notes };
}
export async function prepareTask(provider: AgentProvider, context: ExecutionContext, input: { description: string; title?: string; provider: NativeProviderId }, signal: AbortSignal): Promise<{ title: string; notes: string }> {
  signal.throwIfAborted(); await context.validate();
  const output = await provider.execute({ id: 'task-intake', kind: 'agent', label: 'Prepare task draft', position: { x: 0, y: 0 }, config: {
    provider: input.provider,
    prompt: 'Prepare a task draft only, without tools, code changes or filing files. Return only JSON with exactly seven string fields: title, summary, evidence, scope, acceptanceCriteria, nextSteps, unknowns. Title must be a single line of 1-200 characters; each other field 1-5000 characters. Use the supplied title when present. Separate supplied evidence from assumptions. Do not claim reproduction, testing or external ticket access. State missing facts as unknowns. Preserve the user scope; proposed steps are proposals, not completed work.'
  } }, signal, { ...context, readOnly: true, data: JSON.stringify({ description: input.description, requestedTitle: input.title }), approval: async () => false, input: async () => null });
  signal.throwIfAborted(); await context.validate(); return parseTaskDraft(output);
}
