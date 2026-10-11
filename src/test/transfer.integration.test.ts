import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createWorktree, execGit } from '../git.js';
import { buildTransferPlan, applyTransfer, validateOriginal } from '../transfer.js';
import { makeRepo, writeFile, headSha, type FixtureRepo } from './repoHelper.js';

let fixture: FixtureRepo | null = null;
let wtBase = '';
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  if (wtBase) {
    fs.rmSync(wtBase, { recursive: true, force: true });
    wtBase = '';
  }
});

async function setupWinner(): Promise<{ sha: string; winner: string }> {
  fixture = await makeRepo({
    'src/old.ts': 'export const old = true;\n',
    'assets/logo.bin': Buffer.from([0x89, 0x50, 0x00, 0x01, 0xff]),
  });
  const sha = await headSha(fixture.dir);
  wtBase = fs.mkdtempSync(path.join(os.tmpdir(), 'branchlab-wt-'));
  const winner = path.join(wtBase, 'winner');
  await createWorktree(fixture.dir, { branch: 'branchlab/e1/vw', path: winner, sha });
  return { sha, winner };
}

describe('winner transfer (FR-06)', () => {
  it('applies add/delete/rename/binary + untracked as uncommitted changes; env files excluded (AC-08)', async () => {
    const { sha, winner } = await setupWinner();
    writeFile(winner, 'src/app.ts', 'export const app = 42;\n'); // modify
    fs.rmSync(path.join(winner, 'src/old.ts')); // delete (tracked)
    fs.renameSync(path.join(winner, 'assets/logo.bin'), path.join(winner, 'assets/logo2.bin')); // rename
    // binary content change on a fresh tracked-then-modified path
    writeFile(winner, 'assets/new.bin', Buffer.from([0x00, 0x01, 0x02, 0x00, 0xfe]));
    writeFile(winner, 'src/brand-new.ts', 'export const fresh = 1;\n'); // untracked
    writeFile(winner, '.env.local', 'SECRET=1\n'); // ignored env file — must never appear
    writeFile(winner, 'notes.env', 'X=1\n'); // selected env file (tracked name, untracked content)

    const { plan, problems } = await buildTransferPlan(winner, sha, ['notes.env']);
    expect(problems).toEqual([]);
    expect(plan).not.toBeNull();
    const excludedPaths = plan!.excluded.map((e) => e.path);
    expect(excludedPaths).toContain('notes.env');
    expect(plan!.eligible.some((c) => c.path === '.env.local')).toBe(false);

    const outcome = await applyTransfer({
      repoPath: fixture!.dir, winnerWorktree: winner, plan: plan!,
      expectedFingerprint: plan!.fingerprint, tmpDir: os.tmpdir(),
    });
    expect(outcome.ok).toBe(true);
    expect(fs.readFileSync(path.join(fixture!.dir, 'src/app.ts'), 'utf8')).toContain('42');
    expect(fs.existsSync(path.join(fixture!.dir, 'src/old.ts'))).toBe(false);
    expect(fs.existsSync(path.join(fixture!.dir, 'assets/logo2.bin'))).toBe(true);
    expect(fs.existsSync(path.join(fixture!.dir, 'assets/logo.bin'))).toBe(false);
    expect([...fs.readFileSync(path.join(fixture!.dir, 'assets/new.bin'))]).toEqual([0, 1, 2, 0, 0xfe]);
    expect(fs.existsSync(path.join(fixture!.dir, 'src/brand-new.ts'))).toBe(true);
    expect(fs.existsSync(path.join(fixture!.dir, 'notes.env'))).toBe(false);
    expect(fs.existsSync(path.join(fixture!.dir, '.env.local'))).toBe(false);
    // Changes arrive uncommitted — HEAD unmoved.
    expect(await headSha(fixture!.dir)).toBe(sha);
  });

  it('blocks when the original advanced past the baseline (AC-09)', async () => {
    const { sha } = await setupWinner();
    writeFile(fixture!.dir, 'src/app.ts', 'export const app = 7;\n');
    await execGit(fixture!.dir, ['add', '-A']);
    await execGit(fixture!.dir, ['commit', '-m', 'advance']);
    const problems = await validateOriginal(fixture!.dir, 'main', sha);
    expect(problems.some((p) => p.code === 'baseline-moved')).toBe(true);
  });

  it('aborts when the winner moves after review (AC-10)', async () => {
    const { sha, winner } = await setupWinner();
    writeFile(winner, 'src/app.ts', 'export const app = 5;\n');
    const { plan } = await buildTransferPlan(winner, sha, []);
    writeFile(winner, 'src/app.ts', 'export const app = 6;\n'); // winner moves
    const outcome = await applyTransfer({
      repoPath: fixture!.dir, winnerWorktree: winner, plan: plan!,
      expectedFingerprint: plan!.fingerprint, tmpDir: os.tmpdir(),
    });
    expect(outcome.ok).toBe(false);
    expect(fs.readFileSync(path.join(fixture!.dir, 'src/app.ts'), 'utf8')).toContain('app = 1');
  });
});
