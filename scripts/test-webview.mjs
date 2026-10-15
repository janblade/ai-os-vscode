import { chromium } from 'playwright-core';
import { createServer } from 'node:http';
import { readFile, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { strict as assert } from 'node:assert';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const { exampleWorkflow, applyChange, parseMessage } = require('../.test-build/src/contracts.js');
const { Runner, RunStore } = require('../.test-build/src/core/runner.js');
const { MockProvider } = require('../.test-build/src/providers/mock.js');
const root = path.resolve('.vscode-test', `browser-${randomUUID()}`);
await mkdir(root, { recursive: true });
const server = createServer(async (request, response) => {
  const file = request.url === '/webview.js' ? 'webview.js' : request.url === '/webview.css' ? 'webview.css' : undefined;
  if (file) {
    response.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    response.end(await readFile(path.resolve('dist', file))); return;
  }
  if (request.url !== '/') { response.writeHead(404); response.end(); return; }
  response.setHeader('Content-Type', 'text/html');
  response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'nonce-test'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'none'");
  response.end('<html><head><link rel="stylesheet" href="/webview.css"></head><body><div id="root"></div><script nonce="test">window.acquireVsCodeApi = () => ({ postMessage: message => window.bridge(message) });</script><script nonce="test" src="/webview.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser; let runner; let page;
try {
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1300, height: 1000 } });
  const errors = []; page.on('pageerror', error => errors.push(String(error)));
  let workflow = exampleWorkflow('browser'); workflow.extra = { preserve: true };
  let revision = 1; let trusted = true; let run;
  const post = message => page.evaluate(message => window.postMessage(message, '*'), message);
  const sendDocument = () => post({ type: 'document', revision, workflow, trusted, agents: [{ id: '11111111-1111-1111-1111-111111111111', name: 'Investigator' }] });
  runner = new Runner(new RunStore(root), new MockProvider(), current => { run = current; void post({ type: 'run', run: current }); }, error => errors.push(String(error)));
  await page.exposeFunction('bridge', async raw => {
    const message = parseMessage(raw);
    if (message.type === 'ready') await sendDocument();
    if (message.type === 'update') {
      assert.equal(message.revision, revision); workflow = applyChange(workflow, message.change, randomUUID()); revision++; await sendDocument();
    }
    if (message.type === 'run') await runner.start(workflow, 'file:///workflow', 'file:///repo');
    if (message.type === 'approve') runner.approve(message.runId);
    if (message.type === 'cancel') runner.cancel(message.runId);
  });
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.getByRole('heading', { name: 'Build a workflow' }).waitFor();
  await page.getByRole('textbox', { name: 'Workflow name' }).fill('Browser tested workflow');
  await page.getByRole('button', { name: 'Rename', exact: true }).click();
  await page.getByText('Draft a plan', { exact: true }).click();
  await page.getByLabel('Prompt', { exact: true }).fill('An edited prompt <script>never executes</script>');
  for (const provider of ['gemini', 'copilot']) {
    await page.getByRole('combobox', { name: 'Step provider', exact: true }).selectOption(provider);
    await page.getByRole('button', { name: 'Apply changes' }).click();
    assert.equal(workflow.nodes[0].config.provider, provider);
  }
  await page.getByRole('combobox', { name: 'Step provider', exact: true }).selectOption('codex');
  await page.getByRole('textbox', { name: 'Model (optional)', exact: true }).fill('gpt-5-codex');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  assert.equal(workflow.nodes[0].config.provider, 'codex'); assert.equal(workflow.nodes[0].config.model, 'gpt-5-codex');
  await page.getByRole('combobox', { name: 'Step provider', exact: true }).selectOption('mock');
  await page.getByRole('textbox', { name: 'Model (optional)', exact: true }).fill('');
  await page.getByRole('combobox', { name: 'Agent configuration', exact: true }).selectOption('11111111-1111-1111-1111-111111111111');
  await page.getByRole('button', { name: 'Apply changes' }).click();
  assert.equal(workflow.nodes[0].config.agentId, '11111111-1111-1111-1111-111111111111');
  await page.getByRole('button', { name: '+ Agent', exact: true }).click();
  await page.getByText('Mock agent', { exact: true }).last().waitFor();
  const position = { ...workflow.nodes[0].position };
  const box = await page.locator('.react-flow__node').first().boundingBox();
  await page.mouse.move(box.x + 80, box.y + 40); await page.mouse.down();
  await page.mouse.move(box.x + 115, box.y + 90, { steps: 10 }); await page.mouse.up();
  await page.waitForTimeout(150);
  assert.notDeepEqual(workflow.nodes[0].position, position);
  assert.deepEqual(workflow.extra, { preserve: true });
  assert.equal(workflow.nodes[0].config.prompt, 'An edited prompt <script>never executes</script>');
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Review & approve', exact: true }).waitFor();
  await mkdir(path.resolve('.vscode-test/artifacts'), { recursive: true });
  await page.screenshot({ path: '.vscode-test/artifacts/workflow.png', fullPage: true });
  await page.getByRole('button', { name: 'Review & approve', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'succeeded' }).waitFor();
  assert.equal(run.status, 'succeeded');
  await page.getByRole('button', { name: 'Run workflow', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel run', exact: true }).click();
  await page.getByRole('status').filter({ hasText: 'cancelled' }).waitFor();
  trusted = false; await sendDocument();
  assert.equal(await page.getByRole('button', { name: 'Run workflow', exact: true }).isDisabled(), true);
  assert.equal(await page.getByRole('button', { name: '+ Agent', exact: true }).isDisabled(), true);
  await page.setViewportSize({ width: 600, height: 900 });
  await page.getByRole('button', { name: /^fit view$/i }).click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: '.vscode-test/artifacts/workflow-narrow.png', fullPage: true });
  assert.deepEqual(errors, []);
  console.log('Webview: rename, prompt edit, append, drag, field preservation, run, approval, cancel and restricted mode passed.');
} catch (error) {
  await mkdir(path.resolve('.vscode-test/artifacts'), { recursive: true });
  await page?.screenshot({ path: '.vscode-test/artifacts/failure.png', fullPage: true });
  console.error('Step settings at failure:', await page?.locator('aside').innerText());
  throw error;
} finally {
  await runner?.stop(); await browser?.close();
  await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true });
}
