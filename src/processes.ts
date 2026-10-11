/** ProcessSupervisor (PRD FR-03, FR-07): owns every process BranchLab
 *  starts — installs, dev servers, test runs. Processes are spawned from
 *  argument arrays, tracked by handle (never by port), and stopped as
 *  trees: POSIX process groups, Windows taskkill /T. BranchLab never
 *  kills a process it did not start (AC-04, AC-13). vscode-free. */
import { spawn, type ChildProcess } from 'node:child_process';
import * as http from 'node:http';

const LOG_CAP = 200 * 1024;

export class LogBuffer {
  private text = '';
  append(chunk: string): void {
    this.text += chunk;
    if (this.text.length > LOG_CAP) {
      this.text = this.text.slice(this.text.length - LOG_CAP);
    }
  }
  get(): string {
    return this.text;
  }
  clear(): void {
    this.text = '';
  }
}

interface RunningServer {
  child: ChildProcess;
  startedAt: number;
}

export interface RunResult {
  code: number | null;
  cancelled: boolean;
  timedOut: boolean;
}

export class Supervisor {
  private servers = new Map<string, RunningServer>();
  private logs = new Map<string, LogBuffer>();

  log(key: string): LogBuffer {
    let buf = this.logs.get(key);
    if (!buf) {
      buf = new LogBuffer();
      this.logs.set(key, buf);
    }
    return buf;
  }

  isRunning(key: string): boolean {
    return this.servers.has(key);
  }

  /** Wrap a command for the platform: Windows package-manager shims are
   *  .cmd files, which Node can only launch through cmd.exe. The tokens
   *  passed here are BranchLab-constructed (tool names, ports, the
   *  user's own confirmed test command) — never untrusted data. */
  private spawnSpec(command: string, args: string[]): { command: string; args: string[]; shell: boolean } {
    if (process.platform === 'win32') {
      return { command: 'cmd.exe', args: ['/d', '/s', '/c', command, ...args], shell: false };
    }
    return { command, args, shell: false };
  }

  startServer(key: string, cwd: string, command: string, args: string[]): { ok: boolean; error?: string } {
    if (this.servers.has(key)) {
      return { ok: false, error: 'Already running.' };
    }
    const spec = this.spawnSpec(command, args);
    const buffer = this.log(key);
    try {
      const child = spawn(spec.command, spec.args, {
        cwd,
        shell: spec.shell,
        detached: process.platform !== 'win32',
        windowsHide: true,
        env: { ...process.env, FORCE_COLOR: '0' },
      });
      child.stdout?.on('data', (d: Buffer) => buffer.append(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => buffer.append(d.toString('utf8')));
      child.on('exit', (code) => {
        buffer.append(`\n[branchlab] process exited with code ${code ?? 'unknown'}\n`);
        if (this.servers.get(key)?.child === child) {
          this.servers.delete(key);
        }
        this.onServerExit?.(key, code);
      });
      child.on('error', (err) => buffer.append(`\n[branchlab] failed to start: ${err.message}\n`));
      this.servers.set(key, { child, startedAt: Date.now() });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Called when a tracked server exits on its own (crash or clean). */
  onServerExit: ((key: string, code: number | null) => void) | null = null;

  async stopServer(key: string): Promise<boolean> {
    const running = this.servers.get(key);
    if (!running) {
      return false;
    }
    this.servers.delete(key);
    await killTree(running.child);
    return true;
  }

  /** Run a command to completion (install, tests), streaming output to
   *  the key's log. Supports cancellation and a hard timeout. */
  run(
    key: string,
    cwd: string,
    command: string,
    args: string[],
    opts: { timeoutMs?: number; token?: { cancelled: boolean } } = {},
  ): Promise<RunResult> {
    const spec = this.spawnSpec(command, args);
    const buffer = this.log(key);
    buffer.append(`\n[branchlab] $ ${command} ${args.join(' ')}\n`);
    return new Promise((resolve) => {
      let child: ChildProcess;
      try {
        child = spawn(spec.command, spec.args, {
          cwd,
          shell: spec.shell,
          detached: process.platform !== 'win32',
          windowsHide: true,
          env: { ...process.env, FORCE_COLOR: '0' },
        });
      } catch (err) {
        buffer.append(`[branchlab] failed to start: ${err instanceof Error ? err.message : String(err)}\n`);
        resolve({ code: null, cancelled: false, timedOut: false });
        return;
      }
      let timedOut = false;
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            timedOut = true;
            void killTree(child);
          }, opts.timeoutMs)
        : null;
      const cancelWatcher = opts.token
        ? setInterval(() => {
            if (opts.token!.cancelled) {
              void killTree(child);
            }
          }, 200)
        : null;
      child.stdout?.on('data', (d: Buffer) => buffer.append(d.toString('utf8')));
      child.stderr?.on('data', (d: Buffer) => buffer.append(d.toString('utf8')));
      child.on('error', () => {
        if (timer) clearTimeout(timer);
        if (cancelWatcher) clearInterval(cancelWatcher);
        resolve({ code: null, cancelled: false, timedOut });
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        if (cancelWatcher) clearInterval(cancelWatcher);
        buffer.append(`[branchlab] exited with code ${code ?? 'unknown'}\n`);
        resolve({ code, cancelled: opts.token?.cancelled ?? false, timedOut });
      });
    });
  }

  async stopAll(): Promise<void> {
    const keys = [...this.servers.keys()];
    await Promise.all(keys.map((k) => this.stopServer(k)));
  }
}

/** Kill a whole process tree we own. POSIX: the child was spawned
 *  detached, so signal the process group. Windows: taskkill /T. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    const pid = child.pid;
    if (pid === undefined || child.exitCode !== null) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
      killer.on('close', () => resolve());
      killer.on('error', () => resolve());
    } else {
      try {
        process.kill(-pid, 'SIGTERM');
      } catch {
        try { child.kill('SIGTERM'); } catch { /* already gone */ }
      }
      setTimeout(() => {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch { /* gone */ }
        resolve();
      }, 1500);
    }
  });
}

/** Bounded HTTP readiness (FR-03): any HTTP response — even a 500 — means
 *  the app is reachable (the panel shows "Reachable · App error" for
 *  5xx). A listening socket alone is never consulted. */
export async function waitReady(
  port: number,
  timeoutMs = 30_000,
  intervalMs = 400,
): Promise<{ reachable: boolean; status: number | null }> {
  const deadline = Date.now() + timeoutMs;
  let lastStatus: number | null = null;
  while (Date.now() < deadline) {
    const status = await probeOnce(port);
    if (status !== null) {
      lastStatus = status;
      return { reachable: true, status };
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return { reachable: false, status: lastStatus };
}

function probeOnce(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/', method: 'GET', timeout: 1500 },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? null);
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.end();
  });
}
