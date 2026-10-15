import { runTests } from '@vscode/test-electron';
import { mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const workspace = process.env.AIOS_SMOKE_WORKSPACE;
if (!workspace || !path.isAbsolute(workspace) || !process.env.AIOS_SMOKE_REPOSITORY) throw new Error('Set AIOS_SMOKE_WORKSPACE and AIOS_SMOKE_REPOSITORY explicitly.');
delete process.env.ELECTRON_RUN_AS_NODE;
await mkdir('.vscode-test/artifacts', { recursive: true });
await runTests({
  vscodeExecutablePath: process.env.VSCODE_EXECUTABLE_PATH,
  extensionDevelopmentPath: process.cwd(), extensionTestsPath: path.resolve('dist/test-live-workspace.cjs'),
  extensionTestsEnv: { AIOS_SMOKE_WORKSPACE: workspace, AIOS_SMOKE_REPOSITORY: process.env.AIOS_SMOKE_REPOSITORY },
  launchArgs: [workspace, '--new-window', '--user-data-dir', path.resolve('.vscode-test', `live-profile-${randomUUID()}`), '--disable-extensions', '--disable-gpu'],
});
