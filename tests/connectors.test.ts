import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RpcProcess } from '../src/providers/rpc';
import { automaticEditEligible } from '../src/providers/automatic-approval';
import { CodexProvider } from '../src/providers/codex';
import { ClaudeProvider } from '../src/providers/claude';
import { ExecutionContext } from '../src/providers/context';
import { validateEditPath, validatePermissions, claudeTools } from '../src/providers/boundaries';
import { exampleWorkflow } from '../src/contracts';

const peer = `
const readline=require('node:readline');const send=x=>process.stdout.write(JSON.stringify(x)+'\\n');
const threadId='thread-1',turnId='turn-1';const mode=process.argv[2];
const finish=()=>{send({method:'thread/tokenUsage/updated',params:{threadId:'foreign',turnId,tokenUsage:{total:{inputTokens:9999,outputTokens:9999}}}});send({method:'thread/tokenUsage/updated',params:{threadId,turnId,tokenUsage:{total:{inputTokens:120,outputTokens:30,cachedInputTokens:40}}}});send({method:'item/completed',params:{threadId,turnId,item:{id:'answer',type:'agentMessage',text:'Verified result'}}});send({method:'turn/completed',params:{threadId,turn:{id:turnId,status:'completed'}}});};
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
if(m.method==='initialize')send({id:m.id,result:{}});
if(m.method==='permissionProfile/list')send({id:m.id,result:{data:[{id:'ai_os_bound',allowed:true}]}});
if(m.method==='thread/start')send({id:m.id,result:{thread:{id:threadId},activePermissionProfile:{id:mode==='wrong-profile'?'other':'ai_os_bound'},sandbox:{type:'readOnly'}}});
if(m.method==='turn/start'){
 send({id:m.id,result:{turn:{id:turnId}}});send({method:'turn/started',params:{threadId,turn:{id:turnId}}});
 send({method:'item/agentMessage/delta',params:{threadId,turnId,itemId:'answer',delta:'Inspecting evidence'}});
 send({method:'item/agentMessage/delta',params:{threadId:'foreign',turnId,itemId:'answer',delta:'FOREIGN'}});
 if(mode==='protected') {send({method:'item/started',params:{threadId,turnId,item:{id:'write',type:'fileChange',changes:[{path:'.ai-os/BOOT.md'}]}}});send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'write'}});}
 else if(mode.startsWith('edit-')) {send({method:'item/started',params:{threadId,turnId,item:{id:'write',type:'fileChange',changes:[{path:'src/code.ts',kind:{type:mode==='edit-create'?'add':mode==='edit-delete'?'delete':'other'}}]}}});send({id:'approval',method:'item/fileChange/requestApproval',params:{threadId,turnId,itemId:'write'}});}
 else if(mode==='foreign')send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId:'other',turnId,itemId:'shell',command:'git status'}});
 else if(mode==='input')send({id:'input',method:'item/tool/requestUserInput',params:{threadId,turnId,questions:[{id:'q',question:'Which evidence?',options:[{label:'Logs'}]}]}});
 else send({id:'approval',method:'item/commandExecution/requestApproval',params:{threadId,turnId,itemId:'shell',command:'git status',cwd:process.cwd()}});
}
if(m.id==='approval'&&!m.method){
 const good=mode==='readonly'||mode==='protected'?m.result?.decision==='decline':mode==='foreign'?!!m.error:m.result?.decision==='accept';
 if(!good) process.exit(2);finish();
}
if(m.id==='input'&&!m.method){if(m.result?.answers.q.answers[0]!=='Logs')process.exit(3);finish();}
if(m.method==='run/start') {send({method:'session',params:{id:'claude-session'}});send({method:'output/delta',params:{text:'Inspecting evidence'}});send({id:'c-approval',method:'tool/approval',params:{summary:'Claude: Edit',details:'{}'}});}
if(m.id==='c-approval'&&!m.method){if(m.result!==(mode==='claude-readonly'?false:true))process.exit(4);send({id:1,result:'Claude result'});}
});
`;
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'aios-connector-')); const script = path.join(root, 'peer.cjs');
  await writeFile(script, peer); await mkdir(path.join(root, '.ai-os')); await writeFile(path.join(root, '.ai-os/BOOT.md'), 'protected');
  const usage: unknown[] = [];
  const outputs: string[] = []; const approvals: string[] = []; const sessions: string[] = [];
  const context: ExecutionContext = { runId: 'run', repository: root, frameworkRoot: root, system: 'Synthetic policy', data: 'Synthetic task',
    usage:async value=>{usage.push(value);}, validate: async () => {}, output: async text => { outputs.push(text); }, activity: async () => {}, session: async id => { sessions.push(id); }, approval: async summary => { approvals.push(summary); return true; }, input: async () => 'Logs' };
  return { root, script, context, usage, outputs, approvals, sessions, close: () => rm(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) };
}
test('Codex scopes approvals/input to its turn, rejects protected writes and requires its permission profile', async () => {
  const f = await fixture();
  try {
    for (const mode of ['command', 'protected', 'foreign', 'input']) {
      const provider = new CodexProvider(process.execPath, (_command, _args, cwd) => new RpcProcess(process.execPath, [f.script, mode], cwd));
      assert.equal(await provider.execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, f.context), 'Verified result');
      assert.ok(f.outputs.includes('Inspecting evidence')); assert.ok(!f.outputs.some(text => text.includes('FOREIGN')));
    }
    assert.ok(f.usage.length); assert.ok(f.usage.every((usage:any)=>usage.inputTokens===120 && usage.outputTokens===30 && usage.cachedInputTokens===40));
    assert.equal(f.approvals.length, 1); assert.equal(f.sessions.length, 4);
    const wrong = new CodexProvider(process.execPath, (_command, _args, cwd) => new RpcProcess(process.execPath, [f.script, 'wrong-profile'], cwd));
    await assert.rejects(wrong.execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, f.context), /permission profile/);
  } finally { await f.close(); }
});
test('Claude routes actual tool approvals and saves its native session ID', async () => {
  const f = await fixture();
  try {
    const provider = new ClaudeProvider('native-claude', f.script, (worker, cwd) => new RpcProcess(process.execPath, [worker], cwd));
    assert.equal(await provider.execute(exampleWorkflow('probe').nodes[0], new AbortController().signal, f.context), 'Claude result');
    assert.ok(f.outputs.includes('Inspecting evidence'));
    assert.deepEqual(f.sessions, ['claude-session']); assert.deepEqual(f.approvals, ['Claude: Edit']);
  } finally { await f.close(); }
});
test('native edit gates reject kernel paths and escapes while allowing repository user space', async () => {
  const f = await fixture();
  try {
    await validateEditPath(f.root, f.root, 'src/new.ts');
    await validatePermissions(f.root, f.root, { network: { enabled: true } });
    await assert.rejects(validatePermissions(f.root, f.root, { fileSystem: { write: ['.ai-os'] } }));
    await assert.rejects(validatePermissions(f.root, f.root, { fileSystem: { entries: [{ access: 'write', path: { type: 'glob_pattern', pattern: '**' } }] } }));
    await validateEditPath(f.root, f.root, '.ai-os/progress.md');
    const repo = path.join(f.root, 'repository'); await mkdir(repo);
    await validateEditPath(repo, f.root, path.join(f.root, '.ai-os/memory/proposals/proposal.json'));
    for (const file of ['semantic/knowledge/facts.md', 'tasks/task.md', 'episodic/decisions.jsonl']) await assert.rejects(validateEditPath(repo, f.root, path.join(f.root, '.ai-os/memory', file)));
    await assert.rejects(validateEditPath(repo, f.root, path.join(f.root, '.ai-os/BOOT.md')));
    await assert.rejects(validateEditPath(repo, f.root, path.join(f.root, 'other.txt')));
    for (const file of ['.ai-os/BOOT.md', '.ai-os/rules/new.md', '.ai-os/rules/..named.md', '.ai-os/kernel/..named.md', '.ai-os/memory/semantic/..named.md', '.codex/config.toml', '../outside.ts']) await assert.rejects(validateEditPath(f.root, f.root, file));
  } finally { await f.close(); }
});
test('transport rejects malformed output, times out and cancels owned pending processes', async () => {
  const f = await fixture();
  try {
    const malformed = new RpcProcess(process.execPath, ['-e', "process.stdout.write('broken\\n');setInterval(()=>{},1000)"], f.root);
    await assert.rejects(malformed.request('probe'), /malformed/);
    const idle = new RpcProcess(process.execPath, ['-e', 'process.stdin.resume();setInterval(()=>{},1000)'], f.root);
    await assert.rejects(idle.request('probe', {}, 20), /timed out/);
    const waiting = idle.request('probe'); const closed = idle.close(); await assert.rejects(waiting, /closed/); await closed; assert.ok(idle.child.exitCode !== null || idle.child.signalCode !== null); await malformed.close();
  } finally { await f.close(); }
});
test('bundled Claude worker starts with the SDK without a model call or authentication payload', async () => {
  const f = await fixture();
  const rpc = new RpcProcess(process.execPath, [path.resolve('dist/claude-worker.mjs')], f.root);
  try { assert.deepEqual(await rpc.request('run/health'), { ready: true }); }
  finally { await rpc.close(); await f.close(); }
});

test('task drafting providers cannot elevate approvals or accept write requests', async () => {
  const f = await fixture();
  try {
    const context = { ...f.context, readOnly: true };
    const codex = new CodexProvider(process.execPath, (_command, args, cwd) => {
      assert.ok(args.some(arg => arg.includes(':read-only')));
      assert.ok(args.includes('mcp_servers={}'));
      assert.ok(args.includes('features.hooks=false'));
      return new RpcProcess(process.execPath, [f.script, 'readonly'], cwd);
    });
    assert.equal(await codex.execute(exampleWorkflow('draft').nodes[0], new AbortController().signal, context), 'Verified result');
    const claude = new ClaudeProvider('native-claude', f.script, (worker, cwd) => new RpcProcess(process.execPath, [worker, 'claude-readonly'], cwd));
    assert.equal(await claude.execute(exampleWorkflow('draft').nodes[0], new AbortController().signal, context), 'Claude result');
    assert.equal(f.approvals.length, 0, 'Read-only drafting never asks the host to grant tool permissions');
  } finally { await f.close(); }
});

test('Claude has no shell or external writer escape on Windows and drafting has no tools', () => {
  assert.ok(!claudeTools('win32').includes('Bash'));
  assert.ok(!claudeTools('win32').includes('mcp__filesystem__write_file'));
  assert.ok(claudeTools('win32').includes('Edit'));
  assert.ok(claudeTools('linux').includes('Bash'));
  assert.deepEqual(claudeTools('win32', true), []);
  for (const platform of ['win32', 'linux'] as const) assert.deepEqual(claudeTools(platform, true, true), ['Read', 'Glob', 'Grep', 'AskUserQuestion']);
});

test('Codex preserves operation metadata so native deletions and unknown patches cannot auto-approve', async () => {
  const f = await fixture();
  try {
    for (const mode of ['edit-create','edit-delete','edit-unknown']) {
      let observed = false;
      f.context.approval = async (_summary,_detail,request) => {
        observed = true;
        assert.equal(request?.operation,mode==='edit-create'?'update':mode==='edit-delete'?'delete':'unknown');
        assert.equal(await automaticEditEligible(f.root,f.root,'startup',request),mode==='edit-create');
        return true; // Explicit manual consent still works for nonautomatic operations.
      };
      const provider = new CodexProvider(process.execPath, (_command,_args,cwd) => new RpcProcess(process.execPath,[f.script,mode],cwd));
      await provider.execute(exampleWorkflow('edit-operation').nodes[0],new AbortController().signal,f.context);
      assert.equal(observed,true);
    }
  } finally { await f.close(); }
});
