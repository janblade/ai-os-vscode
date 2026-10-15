import { test, mock } from 'node:test';
import { strict as assert } from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { atomicJson } from '../src/core/files';
test('Windows snapshot replacement retries a transient sharing violation without deleting the prior file', { skip: process.platform !== 'win32' }, async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'aios-atomic-json-'));
  const originalRename = fs.rename;
  try {
    await atomicJson(root, 'state.json', { old: true });
    let attempts = 0;
    const renamed = mock.method(fs, 'rename', async (...args: Parameters<typeof fs.rename>) => {
      if (++attempts === 1) { assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')), { old: true }); throw Object.assign(new Error('sharing violation'), { code: 'EPERM' }); }
      return originalRename(...args);
    });
    try { await atomicJson(root, 'state.json', { updated: true }); } finally { renamed.mock.restore(); }
    assert.equal(attempts, 2); assert.deepEqual(JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8')), { updated: true });
    assert.deepEqual(await fs.readdir(root), ['state.json']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
