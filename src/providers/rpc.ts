import { spawn, execFile, ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';
export type RpcMessage = { id?: number | string; method?: string; params?: any; result?: any; error?: { code?: number; message?: string } };
/** Bounded NDJSON transport. No shell, credential logging or project-selected command. */
export class RpcProcess {
  readonly child: ChildProcessWithoutNullStreams;
  onMessage: (message: RpcMessage) => void = () => {};
  onFailure: (error: Error) => void = () => {};
  private next = 1;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }>();
  private stopped = false;
  private closing?: Promise<void>;
  private exited: Promise<void>;
  constructor(command: string, args: string[], cwd: string, env = process.env, private jsonRpc = false) {
    this.child = spawn(command, args, { cwd, env, shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: 'pipe' });
    this.exited = new Promise(resolve => { this.child.once('exit', () => resolve()); this.child.once('error', () => resolve()); });
    this.child.stderr.on('data', () => {}); // Native diagnostics may contain credentials; never forward raw stderr.
    this.child.stdin.on('error', error => this.fail(error));
    let buffered = 0;
    this.child.stdout.on('data', data => { buffered += data.length; if (buffered > 8 * 1024 * 1024) this.fail(new Error('Provider output exceeded transport limit.')); });
    const lines = createInterface({ input: this.child.stdout, crlfDelay: Infinity });
    lines.on('line', line => {
      buffered = 0;
      try {
        if (line.length > 2 * 1024 * 1024) throw new Error('Provider message exceeded limit.');
        const message: RpcMessage = JSON.parse(line);
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid provider message.');
        const request = typeof message.id === 'number' && !message.method ? this.pending.get(message.id) : undefined;
        if (request) { this.pending.delete(message.id as number); clearTimeout(request.timer); message.error ? request.reject(new Error(String(message.error.message ?? 'Provider request failed').slice(0, 2000))) : request.resolve(message.result); }
        else this.onMessage(message);
      } catch { this.fail(new Error('Provider returned malformed protocol data.')); }
    });
    this.child.on('error', () => this.fail(new Error('Provider executable could not start. Check connector settings.')));
    this.child.on('exit', () => { if (!this.stopped) this.fail(new Error('Provider process exited before completion.')); });
  }
  send(message: RpcMessage): void { if (this.stopped) throw new Error('Provider transport is closed.'); this.child.stdin.write(JSON.stringify({ ...(this.jsonRpc ? { jsonrpc: '2.0' } : {}), ...message }) + '\n'); }
  request(method: string, params: object = {}, timeout = 30000): Promise<any> {
    if (this.stopped) return Promise.reject(new Error('Provider transport is closed.'));
    const id = this.next++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Provider request timed out: ${method}`)); }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); } catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }
  private fail(error: Error): void { if (this.stopped) return; void this.close(error).catch(this.onFailure); this.onFailure(error); }
  close(error = new Error('Provider transport closed.')): Promise<void> {
    if (this.closing) return this.closing;
    this.stopped = true;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(error); }
    this.pending.clear(); this.child.stdin.end();
    this.closing = new Promise<void>((resolve, reject) => {
      if (!this.child.pid) { resolve(); return; }
      if (process.platform === 'win32') {
        execFile(path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe'), ['/PID', String(this.child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, failure => {
          if (failure && this.child.exitCode === null && this.child.signalCode === null) reject(new Error('Provider shutdown could not be confirmed.'));
          else {
            const timer = setTimeout(() => reject(new Error('Provider shutdown could not be confirmed.')), 10000);
            void this.exited.then(() => { clearTimeout(timer); resolve(); });
          }
        });
        return;
      }
      const pid = this.child.pid;
      const kill = (signal: NodeJS.Signals) => { try { process.kill(-pid, signal); } catch (failure) { if ((failure as NodeJS.ErrnoException).code !== 'ESRCH') throw failure; } };
      try { kill('SIGTERM'); } catch (failure) { reject(failure); return; }
      const started = Date.now();
      const poll = setInterval(() => {
        try { process.kill(-pid, 0); if (Date.now() - started > 1000) kill('SIGKILL'); }
        catch (failure) { clearInterval(poll); (failure as NodeJS.ErrnoException).code === 'ESRCH' ? resolve() : reject(failure); return; }
        if (Date.now() - started > 10000) { clearInterval(poll); reject(new Error('Provider shutdown could not be confirmed.')); }
      }, 25);
    });
    return this.closing;
  }
}
