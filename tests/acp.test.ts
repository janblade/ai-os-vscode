import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AcpProvider, acpArguments, geminiPolicy } from '../src/providers/acp';
import { RpcProcess } from '../src/providers/rpc';
import { ExecutionContext } from '../src/providers/context';
import { exampleWorkflow, parseWorkflow } from '../src/contracts';
import { parseAgent } from '../src/framework/agents';

const peer = `
const readline=require('node:readline'),path=require('node:path');
const mode=process.argv[2],sid='session-1';let prompt;
const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');
const finish=()=>{send({method:'session/update',params:{sessionId:'other',update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'FOREIGN'}}}});send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_thought_chunk',content:{type:'text',text:'PRIVATE'}}}});send({method:'session/update',params:{sessionId:sid,update:{sessionUpdate:'agent_message_chunk',content:{type:'text',text:'Verified ACP result'}}}});send({id:prompt,result:{stopReason:'end_turn'}});};
readline.createInterface({input:process.stdin}).on('line',line=>{
const m=JSON.parse(line);if(m.jsonrpc!=='2.0')process.exit(5);
if(m.method==='initialize')send({id:m.id,result:{protocolVersion:1}});
if(m.method==='session/new')send({id:m.id,result:{sessionId:sid}});
if(m.method==='session/prompt'){
prompt=m.id;if(mode==='hang')return;
if(mode==='plain'){finish();return;}
if(mode==='write'||mode==='readonly'||mode==='protected'||mode==='dirty'||mode==='race'||mode==='gemini-config'||mode==='copilot-config')send({id:'fs',method:'fs/write_text_file',params:{sessionId:sid,path:path.join(process.cwd(),mode==='protected'?'.ai-os/BOOT.md':mode==='gemini-config'?'.gemini/settings.json':mode==='copilot-config'?'.copilot/config.json':'result.txt'),content:'Agent edit'}});
else send({id:'permission',method:'session/request_permission',params:{sessionId:sid,toolCall:{kind:mode==='shell'?'execute':mode==='search'?'search':'edit',locations:[{path:path.join(process.cwd(),mode==='kernel'?'.ai-os/BOOT.md':mode==='config-edit'?'.gemini/settings.json':mode==='search'?'.':'result.txt')}]},options:[{kind:'allow_once',optionId:'once'},{kind:'allow_always',optionId:'always'}]}});
}
if(m.id==='fs'&&!m.method){if((mode==='write')!==!!m.result)process.exit(6);finish();}
if(m.id==='permission'&&!m.method){const allowed=m.result?.outcome?.outcome==='selected';if(allowed!==(mode==='edit'||mode==='search'))process.exit(7);if(allowed&&m.result.outcome.optionId!=='once')process.exit(8);finish();}
});
`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-acp-')); await mkdir(path.join(root, '.ai-os')); await writeFile(path.join(root, '.ai-os/BOOT.md'), 'Kernel');
  const script = path.join(root, 'peer.cjs'); await writeFile(script, peer);
  const outputs: string[] = []; const approvals: string[] = [];
  const context: ExecutionContext = { runId: 'fixture', repository: root, frameworkRoot: root, system: 'Policy', data: 'Task', validate: async () => {}, session: async id => { assert.equal(id, 'session-1'); }, output: async text => { outputs.push(text); }, activity: async () => {}, approval: async summary => { approvals.push(summary); return true; }, input: async () => null };
  const provider = (id: 'gemini' | 'copilot', mode: string) => new AcpProvider(id, process.execPath, (_command, _args, cwd) => new RpcProcess(process.execPath, [script, mode], cwd, process.env, true));
  return { root, context, outputs, approvals, provider, close: () => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 25 }) };
}
test('both ACP providers stream only public session output, gate edits and reject shell/kernel writes', async () => {
  const f = await fixture();
  try {
    for (const id of ['gemini', 'copilot'] as const) {
      for (const mode of ['plain', 'write', 'shell', 'kernel', 'edit', 'protected', 'gemini-config', 'copilot-config', 'config-edit', 'search']) {
        assert.equal(await f.provider(id, mode).execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, f.context), 'Verified ACP result');
        assert.equal(await readFile(path.join(f.root, '.ai-os/BOOT.md'), 'utf8'), 'Kernel');
      }
      assert.equal(await readFile(path.join(f.root, 'result.txt'), 'utf8'), 'Agent edit');
    }
    assert.ok(f.outputs.every(text => !text.includes('FOREIGN') && !text.includes('PRIVATE')));
    assert.deepEqual(f.approvals, ['gemini: Save file', 'gemini: Edit files', 'copilot: Save file', 'copilot: Edit files']);
  } finally { await f.close(); }
});
test('ACP read-only drafting cannot write; dirty or externally changed files are preserved; cancel stops the process', async () => {
  const f = await fixture();
  try {
    await f.provider('copilot', 'readonly').execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, { ...f.context, readOnly: true });
    await assert.rejects(access(path.join(f.root, 'result.txt'))); assert.deepEqual(f.approvals, []);
    await writeFile(path.join(f.root, 'result.txt'), 'Original');
    await f.provider('copilot', 'dirty').execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, { ...f.context, validateFileEdit: async () => { throw new Error('Unsaved document'); } });
    assert.equal(await readFile(path.join(f.root, 'result.txt'), 'utf8'), 'Original');
    await f.provider('copilot', 'race').execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, { ...f.context, approval: async () => { await writeFile(path.join(f.root, 'result.txt'), 'External edit'); return true; } });
    assert.equal(await readFile(path.join(f.root, 'result.txt'), 'utf8'), 'External edit');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 200);
    try { await assert.rejects(f.provider('copilot', 'hang').execute(exampleWorkflow('probe').nodes[0], controller.signal, f.context)); } finally { clearTimeout(timer); }
  } finally { await f.close(); }
});
test('new providers round-trip through workflow and agent contracts with constrained launch flags', () => {
  for (const provider of ['gemini', 'copilot'] as const) {
    const flow = exampleWorkflow('fixture'); flow.nodes[0].config.provider = provider; assert.equal(parseWorkflow(JSON.stringify(flow)).nodes[0].config.provider, provider);
    assert.equal(parseAgent(JSON.stringify({ version: 1, id: 'fixture', name: 'Fixture', provider, instructions: 'Investigate' })).provider, provider);
  }
  assert.deepEqual(acpArguments('copilot', true), ['--acp', '--stdio', '--available-tools=view']);
  assert.ok(!acpArguments('copilot', false).join(' ').includes('allow-all'));
  assert.ok(geminiPolicy(true).includes('decision = "deny"')); assert.ok(!geminiPolicy(true).includes('write_file')); assert.ok(geminiPolicy(false).includes('write_file'));
});
