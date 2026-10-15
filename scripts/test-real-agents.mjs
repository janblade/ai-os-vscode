import { runTests } from '@vscode/test-electron';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
if (process.env.AIOS_REAL_AGENTS !== '1' || !process.env.AIOS_REAL_CODEX_PATH) throw new Error('Opt in with AIOS_REAL_AGENTS=1 and AIOS_REAL_CODEX_PATH. This uses real provider allowance.');
const root = process.env.AIOS_REAL_REUSE_ROOT ? path.resolve(process.env.AIOS_REAL_REUSE_ROOT) : path.resolve('.vscode-test', 'real-agents-' + randomUUID());
if (!root.startsWith(path.resolve('.vscode-test') + path.sep) || !path.basename(root).startsWith('real-agents-')) throw new Error('Fixture must stay under .vscode-test/real-agents-*');
if (!process.env.AIOS_REAL_REUSE_ROOT) {
await mkdir(root, { recursive: true });
const payload = JSON.parse(await readFile('dist/framework.json', 'utf8'));
for (const entry of payload.files) {
  const file = path.join(root, '.ai-os', entry.path); await mkdir(path.dirname(file), { recursive: true });
  let content = entry.content;
  if (entry.path === 'manifest.json') { const manifest = JSON.parse(content); manifest.project_name = 'Isolated real-agent addition smoke test'; content = JSON.stringify(manifest, null, 2); }
  await writeFile(file, content);
}
await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ai-os-real-agent-smoke', private: true, scripts: { test: 'node --test --experimental-test-isolation=none add.test.cjs' } }, null, 2));
await writeFile(path.join(root, 'AGENTS.md'), '# Isolated smoke test\nOnly this temporary repository is in scope. Implement add(a,b) in add.cjs and verify add(2,3)===5 in add.test.cjs using node:test. No dependencies, network, deployment, destructive commands or unrelated changes. For Windows use node --test --experimental-test-isolation=none add.test.cjs to avoid spawning a test subprocess. Keep the sandbox enabled. Follow the bound AI OS governance.\n');
await writeFile(path.join(root, '.gitignore'), '.ai-os/memory/runtime/\n');
const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' });
git('init'); git('config', 'user.name', 'AI OS smoke fixture'); git('config', 'user.email', 'fixture@example.invalid'); git('config', 'commit.gpgsign', 'false'); git('add', '.'); git('commit', '-m', 'Create isolated native agent fixture');
const kernel = Object.fromEntries(payload.files.filter(file => /^(BOOT.md|manifest.json|kernel\/|rules\/|genome\/archetypes\/)/.test(file.path)).map(file => [file.path, createHash('sha256').update(file.path === 'manifest.json' ? JSON.stringify({ ...JSON.parse(file.content), project_name: 'Isolated real-agent addition smoke test' }, null, 2) : file.content).digest('hex')]));
await writeFile(path.join(root, '.smoke-owner.json'), JSON.stringify({ root, kernel }));
} else { const owner = JSON.parse(await readFile(path.join(root, '.smoke-owner.json'), 'utf8')); if (owner.root !== root) throw new Error('Not an owned smoke fixture'); }
await mkdir(path.join(root + '-profile', 'User'), { recursive: true });
await writeFile(path.join(root + '-profile', 'User/settings.json'), JSON.stringify({ 'aiOs.codexPath': process.env.AIOS_REAL_CODEX_PATH, 'aiOs.claudePath': process.env.AIOS_REAL_CLAUDE_PATH || '' }));
console.log('Real agent fixture:', root);
delete process.env.ELECTRON_RUN_AS_NODE;
for (const name of Object.keys(process.env)) if (name.startsWith('VSCODE_') && name !== 'VSCODE_EXECUTABLE_PATH') delete process.env[name];
await runTests({ vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH, extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/test-real-agents.cjs'), extensionTestsEnv: { AIOS_REAL_AGENTS: '1', AIOS_REAL_ROOT: root, AIOS_REAL_MIXED: process.env.AIOS_REAL_MIXED || '', AIOS_REAL_NODE_PATH: process.execPath }, launchArgs: [root, '--new-window', '--user-data-dir', root + '-profile', '--disable-extensions', '--disable-gpu', '--skip-welcome', '--skip-release-notes'] });
