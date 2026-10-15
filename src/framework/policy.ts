import { readText, missing, listFiles } from '../core/files';
export async function projectPolicy(framework: string, repository: string): Promise<{ sources: { source: string; content: string }[]; archetype: string; signals: string[] }> {
  const sources: { source: string; content: string }[] = [];
  const load = async (source: string) => { const content = await readText(framework, source); sources.push({ source, content }); return JSON.parse(content); };
  const manifest = await load('.ai-os/manifest.json');
  await load('.ai-os/genome/project_genome.json');
  const index = await load('.ai-os/genome/archetypes/index.json');
  const exists = async (name: string) => { try { await readText(repository, name); return true; } catch (error) { if (missing(error)) return false; throw error; } };
  const signals: string[] = [];
  const ci = await listFiles(repository, '.github/workflows');
  if (ci.length) signals.push('CI present');
  if (ci.length > 1) signals.push('multiple CI workflows');
  if (await exists('LICENSE') || await exists('LICENSE.md')) signals.push('license exists');
  if (await exists('CONTRIBUTING.md')) signals.push('CONTRIBUTING.md');
  if (await exists('SECURITY.md') || await exists('.github/SECURITY.md')) signals.push('security policy');
  if (await exists('.github/CODEOWNERS')) signals.push('code review config');
  if ((await listFiles(repository, 'compliance')).length) signals.push('compliance directory');
  for (const file of ['README.md', 'SECURITY.md', 'CONTRIBUTING.md']) {
    try { if (/\b(?:HIPAA|SOC[ -]?2|PCI(?:[ -]DSS)?)\b/i.test(await readText(repository, file))) signals.push('HIPAA/SOC2/PCI references'); }
    catch (error) { if (!missing(error)) throw error; }
  }
  let archetype = manifest.project_archetype;
  if (archetype === 'auto') archetype = ['critical', 'enterprise', 'startup'].find(name => index.auto_detection_signals[`${name}_signals`]?.some((signal: string) => signals.includes(signal))) ?? 'hobby';
  if (!['hobby', 'startup', 'enterprise', 'critical'].includes(archetype)) throw new Error('Unsupported project archetype.');
  await load(`.ai-os/genome/archetypes/${archetype}.json`);
  for (const source of ['.ai-os/rules/security_policy.md', '.ai-os/rules/evolution_policy.md']) sources.push({ source, content: await readText(framework, source) });
  return { sources, archetype, signals };
}
