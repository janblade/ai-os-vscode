import { createHash, randomUUID } from 'node:crypto';
import { open, rename, unlink, mkdir } from 'node:fs/promises';
import { createFile, readText, safePath, missing, validateRelativePath, listFiles } from '../core/files';
import { object } from '../contracts';
export const hash = (text: string) => createHash('sha256').update(text).digest('hex');
export interface MemoryProposal { version: 1; target: string; expectedHash: string | null; content: string; reason: string; evidence: { scope: 'framework' | 'repository'; source: string; sha256: string }[] }
export function parseProposal(text: string): MemoryProposal {
  const value = object(JSON.parse(text));
  if (value.version !== 1 || typeof value.target !== 'string' || !(/^\.ai-os\/memory\/(semantic|tasks|plans|procedural)\/.+\.md$/.test(value.target) || ['.ai-os/memory/episodic/last_session.json', '.ai-os/memory/episodic/sessions.jsonl'].includes(value.target))
    || !(value.expectedHash === null || typeof value.expectedHash === 'string' && /^[a-f0-9]{64}$/.test(value.expectedHash))
    || typeof value.content !== 'string' || Buffer.byteLength(value.content) > 256000 || typeof value.reason !== 'string' || !value.reason.trim() || value.reason.length > 4000
    || !Array.isArray(value.evidence) || !value.evidence.length || value.evidence.length > 16) throw new Error('Invalid memory proposal.');
  validateRelativePath(value.target);
  if (value.target === '.ai-os/memory/episodic/last_session.json') validSession(JSON.parse(value.content as string));
  if (value.target === '.ai-os/memory/episodic/sessions.jsonl') {
    const rows = (value.content as string).trim().split('\n');
    if (!(value.content as string).endsWith('\n')) throw new Error('Session history must end with a newline.');
    validSession(JSON.parse(rows.at(-1)!));
  }
  for (const raw of value.evidence) { const item = object(raw); if (!['framework', 'repository'].includes(item.scope as string) || typeof item.source !== 'string' || typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) throw new Error('Invalid proposal evidence.'); validateRelativePath(item.source); }
  return value as unknown as MemoryProposal;
}
function validSession(raw: unknown): void {
  const entry = object(raw);
  const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
  if (Object.keys(entry).sort().join(',') !== 'ended,next_up,session_id,started,summary' || typeof entry.session_id !== 'string' || !entry.session_id.trim() || entry.session_id.length > 200 || !(entry.started === null || date(entry.started)) || !date(entry.ended) || typeof entry.summary !== 'string' || !entry.summary.trim() || entry.summary.length > 16000 || typeof entry.next_up !== 'string' || entry.next_up.length > 16000) throw new Error('Invalid session continuity record.');
}
async function equivalentPlan(root: string, proposal: MemoryProposal): Promise<string | undefined> {
  if (proposal.expectedHash !== null || !proposal.target.startsWith('.ai-os/memory/plans/')) return;
  for (const file of await listFiles(root, '.ai-os/memory/plans')) if (file !== proposal.target && file.endsWith('.md') && (await readText(root, file)).replace(/\r\n/g, '\n').trim() === proposal.content.replace(/\r\n/g, '\n').trim()) return file;
}
export async function proposalState(root: string, proposal: MemoryProposal): Promise<'pending' | 'applied' | 'superseded'> {
  let current: string | null = null;
  try { current = await readText(root, proposal.target); } catch (error) { if (!missing(error)) throw error; }
  if (current === proposal.content) return 'applied';
  return (current === null ? null : hash(current)) === proposal.expectedHash ? 'pending' : 'superseded';
}
export async function proposalInventory(root: string): Promise<{ file: string; target: string; state: string; canonical?: string }[]> {
  const entries: { file: string; target: string; state: string; canonical?: string }[] = [];
  const seen = new Map<string, string>();
  for (const file of await listFiles(root, '.ai-os/memory/proposals')) {
    if (!file.endsWith('.json')) continue;
    let proposal: MemoryProposal;
    try { proposal = parseProposal(await readText(root, file)); } catch { continue; }
    const state = await proposalState(root, proposal);
    const key = hash(JSON.stringify([proposal.target, proposal.expectedHash, proposal.content, proposal.evidence]));
    const canonical = seen.get(key) ?? (state === 'pending' ? await equivalentPlan(root, proposal) : undefined);
    entries.push({ file, target: proposal.target, state: state === 'pending' && canonical ? 'duplicate' : state, ...(canonical ? { canonical } : {}) });
    if (!canonical) seen.set(key, file);
  }
  return entries;
}
export async function verifyProposal(root: string, repository: string, proposal: MemoryProposal): Promise<string | null> {
  let original: string | null = null;
  try { original = await readText(root, proposal.target); } catch (error) { if (!missing(error)) throw error; }
  if ((original === null ? null : hash(original)) !== proposal.expectedHash) throw new Error('Memory changed since this proposal was drafted.');
  if (proposal.target === '.ai-os/memory/episodic/sessions.jsonl') {
    const prefix = original ?? '';
    const appended = proposal.content.slice(prefix.length);
    if (!proposal.content.startsWith(prefix) || !appended.trim() || appended.trim().split('\n').length !== 1 || prefix && !prefix.endsWith('\n')) throw new Error('Session history proposals must append exactly one record without changing history.');
    const entry = JSON.parse(appended); validSession(entry);
    if (prefix.split('\n').filter(line=>line.trim()).some(line=>JSON.parse(line).session_id === entry.session_id)) throw new Error('This session is already recorded.');
  }
  const existingPlan = original === null ? await equivalentPlan(root, proposal) : undefined;
  if (existingPlan) throw new Error(`Equivalent plan already exists at ${existingPlan}. Reuse it instead of creating another plan.`);
  const headers = (text: string) => text.match(/^(?:Task-ID|Branch):[^\r\n]*/gm) ?? [];
  if (original && JSON.stringify(headers(original)) !== JSON.stringify(headers(proposal.content))) throw new Error('Preserve task identity headers.');
  const markers = (text: string): string[] => text.match(/<!-- AIOS-ENTRY[^>]*-->/g) ?? [];
  if (original && markers(original).some(marker => !markers(proposal.content).includes(marker))) throw new Error('Preserve identified entry markers when amending memory.');
  for (const item of proposal.evidence) if (hash(await readText(item.scope === 'framework' ? root : repository, item.source)) !== item.sha256) throw new Error('Proposal evidence changed. Verify and draft again.');
  return original;
}
/** Only the host's explicit review action calls this; a proposal cannot carry its own approval. */
export async function applyProposal(root: string, repository: string, proposal: MemoryProposal, validate: () => Promise<void>): Promise<void> {
  await mkdir(await safePath(root, '.ai-os/memory/tasks'), { recursive: true });
  await mkdir(await safePath(root, '.ai-os/memory/episodic'), { recursive: true });
  const lockPath = await safePath(root, '.ai-os/memory/tasks/.dashboard-write.lock');
  const lock = await open(lockPath, 'wx', 0o600);
  let temporary: string | undefined;
  let applied = false;
  try {
    await validate();
    if (await proposalState(root, proposal) === 'applied') return;
    await verifyProposal(root, repository, proposal);
    temporary = `${proposal.target}.${randomUUID()}.tmp`;
    await createFile(root, temporary, proposal.content);
    await validate(); await verifyProposal(root, repository, proposal);
    const receipt = `.ai-os/memory/proposals/accepted-${randomUUID()}.json`;
    await createFile(root, receipt, JSON.stringify({ ts: new Date().toISOString(), type: 'amendment', acceptedBy: 'human-review', target: proposal.target, before: proposal.expectedHash, after: hash(proposal.content), reason: proposal.reason, evidence: proposal.evidence, state: 'prepared' }, null, 2));
    if (proposal.expectedHash === null) await createFile(root, proposal.target, proposal.content);
    else await rename(await safePath(root, temporary), await safePath(root, proposal.target));
    applied = true;
    if (proposal.expectedHash !== null) temporary = undefined;
    // The receipt survives a crash or audit-log failure; it records both hashes for inspection.
    const logPath = await safePath(root, '.ai-os/memory/episodic/decisions.jsonl');
    const log = await open(logPath, 'a', 0o600);
    try { await log.writeFile(JSON.stringify({ ts: new Date().toISOString(), type: 'action', what: `Human-reviewed memory amendment: ${proposal.target}`, why: proposal.reason, receipt }) + '\n'); await log.sync(); }
    finally { await log.close(); }
  } catch (error) { if (applied) throw new Error(`Memory amendment saved, but its audit log could not be updated. Inspect the accepted receipt before retrying: ${String(error)}`); throw error; }
  finally { try { if (temporary) await unlink(await safePath(root, temporary)); } finally { await lock.close(); await unlink(lockPath); } }
}
