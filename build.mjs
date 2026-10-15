import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await import('./scripts/bundle-framework.mjs');
await mkdir('dist/runtime', { recursive: true });
for (const name of ['runtime.py', 'context.py', 'storage.py', 'task_identity.py', 'archive_task.py']) {
  await copyFile(`runtime/${name}`, `dist/runtime/${name}`);
}
await build({ entryPoints: ['src/extension.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/extension.cjs', sourcemap: true });
await build({ entryPoints: ['webview/index.tsx'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/webview.js', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });
await build({ entryPoints: ['tests/extension/suite.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/test-suite.cjs' });
await build({ entryPoints: ['tests/extension/live-workspace.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/test-live-workspace.cjs' });

await build({ entryPoints: ['webview/dashboard.tsx'], bundle: true, platform: 'browser', target: 'es2022', outfile: 'dist/dashboard.js', minify: true, define: { 'process.env.NODE_ENV': '"production"' } });

await build({ entryPoints: ['src/providers/claude-worker.mts'], bundle: true, platform: 'node', format: 'esm', target: 'node20', outfile: 'dist/claude-worker.mjs', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });

await build({ entryPoints: ['tests/extension/real-agents.ts'], bundle: true, platform: 'node', target: 'node20', external: ['vscode'], outfile: 'dist/test-real-agents.cjs' });

await copyFile('node_modules/@anthropic-ai/claude-agent-sdk/LICENSE.md', 'dist/claude-agent-sdk-LICENSE.md');
