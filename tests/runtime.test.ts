import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { createFile } from '../src/core/files';
import { ContextPack, parseContext, previewContext, runtimeRequest } from '../src/framework/runtime';

test('runtime response validation rejects wrong roots, omitted sources, tampering and unexpected files', () => {
  const root = path.resolve('.');
  const request = { frameworkRoot: root, repositoryRoot: root, task: null, files: [] };
  const pack: ContextPack = { format: 'AIOS-bound-context/1', framework_version: 'test', ...request, items: [{
    id: 'framework:.ai-os/BOOT.md', scope: 'framework', source: '.ai-os/BOOT.md', kind: 'governance', reason: 'required',
    content: 'Governance', sha256: createHash('sha256').update('Governance').digest('hex'),
  }] };
  assert.equal(parseContext(pack, request), pack);
  assert.throws(() => parseContext({ ...pack, repositoryRoot: path.dirname(root) }, request));
  assert.throws(() => parseContext({ ...pack, items: [] }, request));
  assert.throws(() => parseContext({ ...pack, items: [{ ...pack.items[0], content: 'Tampered' }] }, request));
  assert.throws(() => parseContext({ ...pack, items: [...pack.items, { ...pack.items[0], id: 'framework:.ai-os/memory/plans/test.md', source: '.ai-os/memory/plans/test.md' }] }, request), /source role/);
  assert.throws(() => parseContext(pack, { ...request, task: '.ai-os/memory/tasks/missing.md' }));
  assert.throws(() => parseContext(pack, { ...request, files: ['missing.py'] }));
  assert.throws(() => parseContext({ ...pack, items: [...pack.items, { ...pack.items[0], id: 'repository:secret', source: 'secret', scope: 'repository' }] }, request));
});

test('bundled-style Python bridge reads explicit sources, reports errors and ignores project Python modules', async () => {
  const root = path.resolve('.test-build', `runtime-${randomUUID()}`);
  await mkdir(root, { recursive: true });
  const script = path.resolve('runtime/runtime.py');
  try {
    await createFile(root, '.ai-os/manifest.json', '{"ai_os_version":"test","installed_skills":[]}');
    await createFile(root, '.ai-os/registry/index.json', '{"skills":[]}');
    await createFile(root, '.ai-os/BOOT.md', 'Governance');
    await createFile(root, 'context.py', 'raise RuntimeError("project Python must never run")');
    await createFile(root, 'source.md', 'Repository source');
    const request = { frameworkRoot: root, repositoryRoot: root, task: null, files: ['source.md'] };
    const pack = await previewContext(script, request);
    assert.equal(pack.items.at(-1)?.content, 'Repository source');
    await assert.rejects(previewContext(script, { ...request, files: ['.env'] }), /Private files/);
    await assert.rejects(runtimeRequest(script, 'capabilities', { large: 'x'.repeat(65536) }), /64 KiB/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
