import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';

// Build only from the reviewed, checked-in distribution; never read a developer's live framework.
const raw = await readFile('framework/distribution.json', 'utf8');
const provenance = JSON.parse(await readFile('framework/provenance.json', 'utf8'));
const digest = text => createHash('sha256').update(text).digest('hex');
if (digest(raw) !== provenance.distributionSha256) throw new Error('Framework distribution checksum mismatch.');
const payload = JSON.parse(raw);
if (payload.format !== 1 || payload.commit !== provenance.commit || !/^[a-f0-9]{40}$/.test(payload.commit) || !Array.isArray(payload.files) || !payload.files.length) throw new Error('Invalid framework distribution.');
const paths = new Set();
for (const file of payload.files) {
  if (typeof file.path !== 'string' || file.path.split('/').some(part => !part || part === '.' || part === '..' || /[\\:\x00-\x1f]/.test(part)) || paths.has(file.path.toLowerCase()) || typeof file.content !== 'string' || digest(file.content) !== file.sha256) throw new Error('Invalid framework file or checksum.');
  if (/^memory\/(tasks|plans|archived_tasks)\/.+\.md$/.test(file.path)) throw new Error('Distribution contains working task memory.');
  paths.add(file.path.toLowerCase());
}
const manifest = JSON.parse(payload.files.find(file => file.path === 'manifest.json').content);
if (manifest.project_name || manifest.project_archetype !== 'auto' || manifest.boot_count || manifest.last_boot || manifest.evolution_history.total_evolutions) throw new Error('Distribution is not a fresh-install baseline.');
for (const [file, expected] of Object.entries(provenance.runtimeSha256)) {
  if (!/^runtime\/[a-z_]+\.py$/.test(file) || digest(await readFile(file)) !== expected) throw new Error('Runtime utility checksum mismatch.');
}
await mkdir('dist', { recursive: true });
await writeFile('dist/framework.json', JSON.stringify(payload));
