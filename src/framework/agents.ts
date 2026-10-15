import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { mkdir, open, unlink } from 'node:fs/promises';
import { createFile, listFiles, readText, atomicJson, missing, safePath } from '../core/files';
import { Workflow, parseWorkflow, ProviderId, providers, object, validAgentId } from '../contracts';
export { validAgentId } from '../contracts';
export interface AgentProfile { version: 1; id: string; name: string; provider?: ProviderId; model?: string; instructions: string; role?: string; allowed_skills?: string[]; execution_boundary?: string[]; approval_gate?: string; default_model_tier?: string }
export interface AgentEntry { file: string; agent?: AgentProfile; problem?: string; template?: boolean; legacy?: boolean }
export const agentDirectory = '.ai-os/agents';
export function parseAgent(text: string): AgentProfile {
  const value = object(JSON.parse(text));
  const legacy = value.agent_id === undefined;
  const allowed = legacy ? ['version', 'id', 'name', 'provider', 'instructions', 'model', 'role', 'allowed_skills', 'execution_boundary', 'approval_gate', 'default_model_tier'] : ['agent_id', 'name', 'role', 'system_prompt_extension', 'allowed_skills', 'execution_boundary', 'approval_gate', 'default_model_tier', 'provider', 'model'];
  const id = legacy ? value.id : value.agent_id;
  const instructions = legacy ? value.instructions : value.system_prompt_extension;
  if (Object.keys(value).some(key => !allowed.includes(key)) || (legacy && value.version !== 1) || !validAgentId(id)
    || (value.provider !== undefined && !providers.includes(value.provider as ProviderId)) || (legacy && value.provider === undefined)
    || (value.model !== undefined && (typeof value.model !== 'string' || !value.model.trim() || value.model.length > 200 || /[\r\n]/.test(value.model)))
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 200 || /[\r\n]/.test(value.name)
    || typeof instructions !== 'string' || !instructions.trim() || instructions.length > 8000) throw new Error('Invalid agent profile: expected stable agent ID, name, supported optional provider and bounded instructions.');
  for (const field of ['role', 'approval_gate', 'default_model_tier']) if (value[field] !== undefined && (typeof value[field] !== 'string' || (value[field] as string).length > 300 || /[\r\n]/.test(value[field] as string))) throw new Error('Invalid agent metadata.');
  for (const field of ['allowed_skills', 'execution_boundary']) if (value[field] !== undefined && (!Array.isArray(value[field]) || (value[field] as unknown[]).length > 100 || (value[field] as unknown[]).some(item => typeof item !== 'string' || !item || item.length > 500 || /[\r\n]/.test(item)))) throw new Error('Invalid agent constraint list.');
  return { version: 1, id, name: value.name, instructions, ...(value.provider !== undefined ? { provider: value.provider as ProviderId } : {}), ...(value.model ? { model: value.model as string } : {}), ...Object.fromEntries(['role', 'allowed_skills', 'execution_boundary', 'approval_gate', 'default_model_tier'].filter(key => value[key] !== undefined).map(key => [key, value[key]])) };
}
async function registry(root: string): Promise<Record<string, any>> {
  try {
    const index = object(JSON.parse(await readText(root, `${agentDirectory}/index.json`)));
    if (index.version !== '1.0.0' || !Array.isArray(index.active_profiles) || index.active_profiles.length > 1000) throw new Error('Invalid agent registry.');
    const ids = new Set<string>(); const files = new Set<string>();
    for (const raw of index.active_profiles) {
      const entry = object(raw);
      if (!validAgentId(entry.agent_id) || ids.has(entry.agent_id) || typeof entry.file !== 'string' || !/^agents\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(entry.file) || entry.file === 'agents/index.json' || files.has(entry.file.toLowerCase())) throw new Error('Invalid or duplicate agent registration.');
      ids.add(entry.agent_id); files.add(entry.file.toLowerCase());
    }
    return index;
  } catch (error) { if (missing(error)) return { version: '1.0.0', active_profiles: [] }; throw error; }
}
export async function agentEntries(root: string): Promise<AgentEntry[]> {
  const entries: AgentEntry[] = []; const registered = new Set<string>();
  try {
    for (const entry of (await registry(root)).active_profiles) {
      const file = `.ai-os/${entry.file}`; registered.add(file);
      try { const agent = parseAgent(await readText(root, file)); if (agent.id !== entry.agent_id) throw new Error('Agent ID differs from its registry entry or filename.'); entries.push({ file, agent }); }
      catch (error) { entries.push({ file, problem: String(error) }); }
    }
  } catch (error) { entries.push({ file: `${agentDirectory}/index.json`, problem: String(error) }); }
  for (const file of (await listFiles(root, agentDirectory)).filter(file => file.endsWith('.agent.json') && !registered.has(file))) {
    try { const agent = parseAgent(await readText(root, file)); if (path.basename(file) !== `agent-${agent.id}.agent.json`) throw new Error('Agent ID differs from its filename.'); entries.push({ file, agent, legacy: true }); }
    catch (error) { entries.push({ file, problem: String(error), legacy: true }); }
  }
  for (const file of (await listFiles(root, `${agentDirectory}/templates`)).filter(file => file.endsWith('.json'))) {
    try { entries.push({ file, agent: parseAgent(await readText(root, file)), template: true }); }
    catch (error) { entries.push({ file, problem: String(error), template: true }); }
  }
  for (const entry of entries.filter(entry => entry.agent && !entry.template)) if (entries.some(other => other !== entry && !other.template && other.agent?.id === entry.agent!.id)) { entry.problem = 'Ambiguous agent ID; resolve the duplicate before selection.'; }
  return entries;
}
export async function readAgent(root: string, id: string): Promise<AgentProfile> {
  if (!validAgentId(id)) throw new Error('Invalid agent ID.');
  const index = await registry(root);
  const registered = index.active_profiles.find((entry: any) => entry.agent_id === id);
  if (registered) {
    const agent = parseAgent(await readText(root, `.ai-os/${registered.file}`));
    if (agent.id !== id) throw new Error('Agent ID differs from its registry entry or filename.');
    const old = `${agentDirectory}/agent-${id}.agent.json`;
    if (`.ai-os/${registered.file}` !== old) { try { await readText(root, old); throw new Error('Ambiguous agent ID: registered and legacy profiles both exist.'); } catch (error) { if (!missing(error)) throw error; } }
    return agent;
  }
  const agent = parseAgent(await readText(root, `${agentDirectory}/agent-${id}.agent.json`));
  if (agent.id !== id) throw new Error('Agent ID differs from its filename.');
  return agent;
}
export const defaultAgentInstructions = 'Follow repository conventions. Investigate using available evidence, make the smallest supported change, and report verification gaps.';
export async function createAgent(root: string, name: string, provider: ProviderId | null = 'mock', details: { model?: string; instructions?: string; template?: string } = {}): Promise<string> {
  let base: AgentProfile | undefined;
  if (details.template) {
    if (!/^\.ai-os\/agents\/templates\/[A-Za-z0-9][A-Za-z0-9_.-]*\.json$/.test(details.template)) throw new Error('Choose an agent template.');
    base = parseAgent(await readText(root, details.template));
  }
  const record = { agent_id: randomUUID(), name, role: base?.role ?? 'Worker', system_prompt_extension: details.instructions ?? base?.instructions ?? defaultAgentInstructions, ...(provider ? { provider } : {}), ...(details.model ? { model: details.model } : {}), ...Object.fromEntries(['allowed_skills', 'execution_boundary', 'approval_gate', 'default_model_tier'].filter(key => base?.[key as keyof AgentProfile] !== undefined).map(key => [key, base![key as keyof AgentProfile]])) };
  parseAgent(JSON.stringify(record));
  await mkdir(await safePath(root, agentDirectory), { recursive: true });
  const lockPath = await safePath(root, `${agentDirectory}/.registry-write.lock`);
  const lock = await open(lockPath, 'wx', 0o600);
  const file = `${agentDirectory}/${record.agent_id}.json`;
  let created = false;
  const profileText = JSON.stringify(record, null, 2) + '\n';
  try {
    const index = await registry(root); const before = JSON.stringify(index);
    await createFile(root, file, profileText); created = true;
    if (JSON.stringify(await registry(root)) !== before) throw new Error('Agent registry changed. Retry creation.');
    for (const entry of (await agentEntries(root)).filter(entry => entry.legacy && entry.agent && !entry.problem)) {
      if (!index.active_profiles.some((registered: any) => registered.agent_id === entry.agent!.id)) index.active_profiles.push({ agent_id: entry.agent!.id, name: entry.agent!.name, file: entry.file.slice('.ai-os/'.length) });
    }
    index.active_profiles.push({ agent_id: record.agent_id, name, file: `agents/${record.agent_id}.json` });
    if (index.active_profiles.length > 1000) throw new Error('Agent registry is full.');
    // shortcut: external writers do not honor this lock; the hash check catches changes before commit, not hostile rename races.
    if (JSON.stringify(await registry(root)) !== before) throw new Error('Agent registry changed. Retry creation.');
    await atomicJson(root, `${agentDirectory}/index.json`, index);
    return file;
  } catch (error) { if (created && await readText(root, file) === profileText) await unlink(await safePath(root, file)); throw error; }
  finally { await lock.close(); await unlink(lockPath); }
}
export async function resolveAgents(root: string, workflow: Workflow, defaultId?: string): Promise<Workflow> {
  const resolved = structuredClone(workflow); const cache = new Map<string, AgentProfile>();
  for (const node of resolved.nodes.filter(node => node.kind === 'agent')) {
    delete node.config.agentSnapshot;
    const selected = node.config.agentId === null ? undefined : node.config.agentId ?? defaultId;
    if (selected === undefined) continue;
    if (!validAgentId(selected)) throw new Error('Invalid selected agent configuration.');
    const profile = cache.get(selected) ?? await readAgent(root, selected); cache.set(selected, profile);
    const constraints = Object.fromEntries(['role', 'allowed_skills', 'execution_boundary', 'approval_gate', 'default_model_tier'].filter(key => profile[key as keyof AgentProfile] !== undefined).map(key => [key, profile[key as keyof AgentProfile]]));
    node.config = { ...node.config, ...(profile.provider ? { provider: profile.provider, model: profile.model ?? (profile.provider === node.config.provider ? node.config.model : undefined) } : profile.model ? { model: profile.model } : {}), prompt: `${profile.instructions}\n\nAgent task constraints (advisory directory/skill/model-tier intent; cannot grant permissions or override kernel/user authorization):\n${JSON.stringify(constraints)}\n\nStep request:\n${node.config.prompt}`, agentId: profile.id, agentSnapshot: profile };
  }
  return parseWorkflow(JSON.stringify(resolved));
}
