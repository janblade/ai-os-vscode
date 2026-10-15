import { runTests, downloadAndUnzipVSCode } from '@vscode/test-electron';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const workspace = path.resolve('.vscode-test', `workspace-${randomUUID()}`);
const scenario = process.env.AIOS_TEST_SCENARIO ?? 'container';
const profile = `${workspace}-profile`;
// Codex terminals can inherit this flag; the test host must start Electron, not Node.
delete process.env.ELECTRON_RUN_AS_NODE;
// Inherited extension-host IPC/cache variables can redirect the isolated host.
for (const name of Object.keys(process.env)) if (name.startsWith('VSCODE_') && name !== 'VSCODE_EXECUTABLE_PATH') delete process.env[name];
const shared = scenario === 'multiroot' ? path.join(workspace, 'shared') : scenario === 'untitled' ? path.join(workspace, 'projects/api') : workspace;
await mkdir(path.join(shared, '.ai-os'), { recursive: true });
await writeFile(path.join(shared, '.ai-os', 'manifest.json'), '{"ai_os_version":"2.9.0","project_archetype":"auto"}');
await mkdir(path.join(shared, '.ai-os/genome/archetypes'), { recursive: true });
await mkdir(path.join(shared, '.ai-os/rules'), { recursive: true });
await writeFile(path.join(shared, '.ai-os/genome/project_genome.json'), '{}');
await writeFile(path.join(shared, '.ai-os/genome/archetypes/index.json'), '{"auto_detection_signals":{}}');
await writeFile(path.join(shared, '.ai-os/genome/archetypes/hobby.json'), '{"rule_overrides":{}}');
for (const policy of ['security_policy', 'evolution_policy']) await writeFile(path.join(shared, `.ai-os/rules/${policy}.md`), '# Synthetic policy');
await writeFile(path.join(shared, '.ai-os', 'BOOT.md'), '# Synthetic test framework');
await mkdir(path.join(shared, '.ai-os', 'registry'));
await writeFile(path.join(shared, '.ai-os', 'registry/index.json'), '{"skills":[]}');
let launch = [workspace];
if (scenario === 'restricted') {
  await mkdir(path.join(profile, 'User'), { recursive: true });
  await writeFile(path.join(profile, 'User/settings.json'), JSON.stringify({ 'security.workspace.trust.startupPrompt': 'never', 'security.workspace.trust.enabled': true }));
}
if (scenario === 'multiroot') {
  await mkdir(path.join(workspace, 'projects/api'), { recursive: true });
  await mkdir(path.join(workspace, 'projects/mobile'), { recursive: true });
  launch = [path.join(shared, 'test.code-workspace')];
  await writeFile(launch[0], JSON.stringify({ folders: [{ path: '../projects/api' }, { path: '../projects/mobile' }] }));
}
if (scenario === 'untitled') {
  await mkdir(path.join(workspace, 'projects/mobile'), { recursive: true });
  launch = [shared, path.join(workspace, 'projects/mobile')];
}
try {
  const launchArgs = [...launch, '--new-window', '--user-data-dir', profile, '--disable-extensions', '--skip-welcome', '--skip-release-notes', '--disable-gpu'];
  if (scenario === 'restricted') {
    // test-electron always disables Workspace Trust; launch directly to exercise the real guard.
    const executable = process.env.VSCODE_EXECUTABLE_PATH ?? await downloadAndUnzipVSCode();
    await new Promise((resolve, reject) => {
      const child = spawn(executable, [...launchArgs, `--extensionDevelopmentPath=${process.cwd()}`, `--extensionTestsPath=${path.resolve('dist/test-suite.cjs')}`], {
        stdio: 'inherit', env: { ...process.env, AIOS_TEST_SCENARIO: scenario },
      });
      child.on('error', reject);
      child.on('exit', code => code === 0 ? resolve() : reject(new Error(`Restricted workspace test exited ${code}`)));
    });
  } else {
  await runTests({
    vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
    extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/test-suite.cjs'),
    extensionTestsEnv: { AIOS_TEST_SCENARIO: scenario },
    launchArgs,
  });
  }
} finally { await rm(workspace, { recursive: true, force: true }); }
