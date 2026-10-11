import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { preflight, createWorktree, listWorktrees, execGit, detectPackageManager } from '../git.js';
import { computeChanges, fingerprintChanges } from '../diff.js';
import { buildTransferPlan, applyTransfer, validateOriginal } from '../transfer.js';
import { makeRepo, writeFile, headSha, type FixtureRepo } from './repoHelper.js';

let fixture: FixtureRepo | null = null;
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
});

describe('preflight (FR-01)', () => {
  it('passes a clean committed repo and pins the baseline', async () => {
    fixture = await makeRepo();
    const { info, problems } = await preflight(fixture.dir);
    expect(problems).toEqual([]);
    expect(info?.branch).toBe('main');
    expect(info?.headSha).toMatch(/^[0-9a-f]{40}$/);
  });

  it('blocks a dirty tree and untracked files (AC-02)', async () => {
    fixture = await makeRepo();
    writeFile(fixture.dir, 'src/app.ts', 'export const app = 2;\n');
    let result = await preflight(fixture.dir);
    expect(result.problems.some((p) => p.code === 'dirty')).toBe(true);
    await execGit(fixture.dir, ['checkout', '--', 'src/app.ts']);
    writeFile(fixture.dir, 'stray.txt', 'x');
    result = await preflight(fixture.dir);
    expect(result.problems.some((p) => p.code === 'dirty')).toBe(true);
  });

  it('blocks a detached HEAD', async () => {
    fixture = await makeRepo();
    await execGit(fixture.dir, ['checkout', '--detach', 'HEAD']);
    const result = await preflight(fixture.dir);
    expect(result.problems.some((p) => p.code === 'detached')).toBe(true);
  });

  it('detects the package manager from the lockfile', async () => {
    fixture = await makeRepo();
    expect(detectPackageManager(fixture.dir)).toEqual({ pm: 'npm', ambiguous: false });
  });
});

describe('worktrees + diff (AC-01, AC-03)', () => {
  it('variants share the exact baseline sha; edits stay isolated', async () => {
    fixture = await makeRepo();
    const sha = await headSha(fixture.dir);
    const base = fs.mkdtempSync(path.join(fixture.dir, '..', 'wt-'));
    const a = path.join(base, 'a');
    const b = path.join(base, 'b');
    expect((await createWorktree(fixture.dir, { branch: 'branchlab/e1/va', path: a, sha })).code).toBe(0);
    expect((await createWorktree(fixture.dir, { branch: 'branchlab/e1/vb', path: b, sha })).code).toBe(0);
    expect(await headSha(a)).toBe(sha);
    expect(await headSha(b)).toBe(sha);

    writeFile(a, 'src/app.ts', 'export const app = 99;\n');
    writeFile(a, 'src/new.ts', 'export const n = 1;\n');
    const changesA = await computeChanges(a, sha);
    const changesB = await computeChanges(b, sha);
    expect(changesA.map((c) => `${c.status}:${c.path}`)).toEqual(['modified:src/app.ts', 'added:src/new.ts']);
    expect(changesB).toEqual([]);
    expect(fingerprintChanges(a, changesA)).not.toBe(fingerprintChanges(b, changesB));

    const trees = await listWorktrees(fixture.dir);
    expect(trees.length).toBe(3);
    fs.rmSync(base, { recursive: true, force: true });
  });
});
