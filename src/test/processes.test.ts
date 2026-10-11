import { describe, it, expect, afterEach } from 'vitest';
import { Supervisor, waitReady } from '../processes.js';
import { pickPort } from '../ports.js';
import { inspectApp, devCommand, installCommand, splitCommand } from '../adapters.js';
import { makeRepo, type FixtureRepo } from './repoHelper.js';

const supervisor = new Supervisor();
afterEach(async () => {
  await supervisor.stopAll();
});

const SERVER_SCRIPT = `
const http = require('http');
const port = Number(process.argv[1]);
http.createServer((req, res) => { res.writeHead(200, {'Content-Type':'text/html'}); res.end('<h1>variant</h1>'); }).listen(port, '127.0.0.1', () => console.log('variant up'));
`;

describe('process supervision (AC-04, AC-05, AC-13)', () => {
  it('starts a server, detects readiness, stops only its own tree', async () => {
    const port = await pickPort(4400, 4499);
    expect(port).not.toBeNull();
    // An unrelated server squats the next port.
    const otherPort = port! + 1;
    expect(supervisor.startServer('squat', process.cwd(), process.execPath, ['-e', SERVER_SCRIPT, String(otherPort)]).ok).toBe(true);
    expect((await waitReady(otherPort, 8000)).reachable).toBe(true);
    // The allocator routes around the squatter instead of killing it.
    expect(await pickPort(port!, port! + 5, new Set([port!]))).toBe(port! + 2);

    expect(supervisor.startServer('mine', process.cwd(), process.execPath, ['-e', SERVER_SCRIPT, String(port)]).ok).toBe(true);
    const ready = await waitReady(port!, 8000);
    expect(ready).toEqual({ reachable: true, status: 200 });
    expect(supervisor.isRunning('mine')).toBe(true);

    await supervisor.stopServer('mine');
    expect(supervisor.isRunning('mine')).toBe(false);
    expect((await waitReady(port!, 600, 150)).reachable).toBe(false);
    // The unrelated server is untouched.
    expect((await waitReady(otherPort, 3000)).reachable).toBe(true);
    expect(supervisor.log('mine').get()).toContain('variant');
  }, 30000);

  it('run() reports real exit codes (AC-07)', async () => {
    const fail = await supervisor.run('t1', process.cwd(), process.execPath, ['-e', 'process.exit(3)']);
    expect(fail.code).toBe(3);
    const pass = await supervisor.run('t2', process.cwd(), process.execPath, ['-e', 'console.log("ok")']);
    expect(pass.code).toBe(0);
    expect(supervisor.log('t2').get()).toContain('ok');
  }, 20000);
});

describe('adapters', () => {
  let fixture: FixtureRepo | null = null;
  afterEach(() => fixture?.cleanup());

  it('detects vite from the fixture package.json and builds commands', async () => {
    fixture = await makeRepo();
    const info = inspectApp(fixture.dir);
    expect(info.adapter).toBe('vite');
    expect(info.hasDevScript).toBe(true);
    expect(devCommand('vite', 'npm', 4300)).toEqual({
      command: 'npx', args: ['vite', '--port', '4300', '--host', '127.0.0.1', '--strictPort'],
    });
    expect(devCommand('next', 'pnpm', 4301)).toEqual({
      command: 'pnpm', args: ['exec', 'next', 'dev', '-p', '4301', '-H', '127.0.0.1'],
    });
    expect(installCommand('npm').args).toEqual(['ci']);
    expect(installCommand('yarn').args).toEqual(['install', '--immutable']);
  });

  it('splits user test commands with quoting', () => {
    expect(splitCommand('npm test')).toEqual({ command: 'npm', args: ['test'] });
    expect(splitCommand('node --test "my dir/x.js"')).toEqual({ command: 'node', args: ['--test', 'my dir/x.js'] });
    expect(splitCommand('')).toBeNull();
    expect(splitCommand('npm "test')).toBeNull();
  });
});
