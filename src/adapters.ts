/** FrameworkAdapters (PRD FR-03): explicit Vite / Next.js support.
 *  Adapters build argument arrays for the repo's package manager — ports
 *  and hosts are passed the way each framework actually accepts them
 *  (never by hoping a PORT env var works). Detection reads package.json;
 *  the user confirms the adapter during setup. Pure, unit-tested. */
import * as fs from 'node:fs';
import * as path from 'node:path';

export type AdapterId = 'vite' | 'next';
export type PackageManager = 'npm' | 'pnpm' | 'yarn';

export interface AppInfo {
  adapter: AdapterId | null;
  /** Every framework detected (ambiguity → user chooses). */
  detected: AdapterId[];
  hasDevScript: boolean;
  hasTestScript: boolean;
  scripts: Record<string, string>;
}

export function inspectApp(appRoot: string): AppInfo {
  let pkg: { dependencies?: Record<string, string>; devDependencies?: Record<string, string>; scripts?: Record<string, string> } = {};
  try {
    pkg = JSON.parse(fs.readFileSync(path.join(appRoot, 'package.json'), 'utf8')) as typeof pkg;
  } catch {
    return { adapter: null, detected: [], hasDevScript: false, hasTestScript: false, scripts: {} };
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const detected: AdapterId[] = [];
  if ('vite' in deps || fs.existsSync(path.join(appRoot, 'vite.config.ts')) || fs.existsSync(path.join(appRoot, 'vite.config.js'))) {
    detected.push('vite');
  }
  if ('next' in deps || fs.existsSync(path.join(appRoot, 'next.config.js')) || fs.existsSync(path.join(appRoot, 'next.config.mjs')) || fs.existsSync(path.join(appRoot, 'next.config.ts'))) {
    detected.push('next');
  }
  const scripts = pkg.scripts ?? {};
  return {
    adapter: detected.length === 1 ? detected[0]! : null,
    detected,
    hasDevScript: typeof scripts.dev === 'string',
    hasTestScript: typeof scripts.test === 'string',
    scripts,
  };
}

/** The executable + args to run a package.json script under a manager. */
export function scriptCommand(pm: PackageManager, script: string, extraArgs: string[] = []): { command: string; args: string[] } {
  switch (pm) {
    case 'npm':
      return { command: 'npm', args: ['run', script, ...(extraArgs.length ? ['--', ...extraArgs] : [])] };
    case 'pnpm':
      return { command: 'pnpm', args: ['run', script, ...extraArgs] };
    case 'yarn':
      return { command: 'yarn', args: [script, ...extraArgs] };
  }
}

/** Lockfile-enforced install (FR-03): ci / --frozen-lockfile — an
 *  incompatible lockfile fails loudly instead of being rewritten. */
export function installCommand(pm: PackageManager): { command: string; args: string[] } {
  switch (pm) {
    case 'npm':
      return { command: 'npm', args: ['ci'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['install', '--frozen-lockfile'] };
    case 'yarn':
      return { command: 'yarn', args: ['install', '--immutable'] };
  }
}

/** Dev-server launch for an adapter at an allocated port. We run the
 *  framework binary directly (not the project's dev script) so port and
 *  host are guaranteed: Vite takes --port/--host/--strictPort; Next
 *  takes -p/-H. The project's own dev script is shown in setup so the
 *  user sees what it would have done. */
export function devCommand(
  adapter: AdapterId,
  pm: PackageManager,
  port: number,
): { command: string; args: string[] } {
  const bin = adapter === 'vite' ? 'vite' : 'next';
  const flagArgs = adapter === 'vite'
    ? ['--port', String(port), '--host', '127.0.0.1', '--strictPort']
    : ['dev', '-p', String(port), '-H', '127.0.0.1'];
  switch (pm) {
    case 'npm':
      return { command: 'npx', args: [bin, ...flagArgs] };
    case 'pnpm':
      return { command: 'pnpm', args: ['exec', bin, ...flagArgs] };
    case 'yarn':
      return { command: 'yarn', args: [bin, ...flagArgs] };
  }
}

/** An arbitrary user-configured test command: split respecting simple
 *  quoting. The command is the user's own (shown before it ever runs);
 *  it is executed in the variant worktree by the supervisor. */
export function splitCommand(commandLine: string): { command: string; args: string[] } | null {
  const tokens: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (const ch of commandLine.trim()) {
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = '';
      }
    } else {
      current += ch;
    }
  }
  if (quote) {
    return null;
  }
  if (current) {
    tokens.push(current);
  }
  if (tokens.length === 0) {
    return null;
  }
  return { command: tokens[0]!, args: tokens.slice(1) };
}
