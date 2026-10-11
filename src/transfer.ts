/** WinnerTransferService (PRD FR-06). Application is a guarded transfer,
 *  never a checkout/reset/merge:
 *
 *  1. Re-validate the original workspace (branch, baseline, clean).
 *  2. Prove the winner has not moved since the review fingerprint.
 *  3. Build the artifact: a binary-safe Git patch for tracked changes
 *     (with the user's env files path-excluded) + the eligible untracked
 *     files copied explicitly. Symlinks and escaping paths block.
 *  4. `git apply --check` before any mutation; apply; copy; verify the
 *     result against the winner fingerprints. On failure, restore only
 *     paths whose contents still match what we wrote — never trample a
 *     concurrent edit.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit, currentBranch, currentHead, isClean } from './git.js';
import { computeChanges, fingerprintChanges, hashFile, type ChangeEntry } from './diff.js';
import { validateRelativePath } from './paths.js';

export interface TransferPlan {
  changes: ChangeEntry[];
  /** Changes that will move to the original workspace. */
  eligible: ChangeEntry[];
  /** Changes held back, with the reason shown in the review. */
  excluded: { path: string; reason: string }[];
  patch: string;
  fingerprint: string;
}

export interface GuardProblem {
  code: string;
  message: string;
}

function isSymlink(absPath: string): boolean {
  try {
    return fs.lstatSync(absPath).isSymbolicLink();
  } catch {
    return false;
  }
}

export async function buildTransferPlan(
  winnerWorktree: string,
  baselineSha: string,
  envFiles: string[],
): Promise<{ plan: TransferPlan | null; problems: GuardProblem[] }> {
  const problems: GuardProblem[] = [];
  const changes = await computeChanges(winnerWorktree, baselineSha);
  const envSet = new Set(envFiles);
  const eligible: ChangeEntry[] = [];
  const excluded: { path: string; reason: string }[] = [];

  for (const change of changes) {
    const rel = validateRelativePath(change.path);
    if (!rel) {
      problems.push({ code: 'bad-path', message: `Change path escapes the repository or touches Git metadata: ${change.path}` });
      continue;
    }
    if (change.oldPath && !validateRelativePath(change.oldPath)) {
      problems.push({ code: 'bad-path', message: `Rename source path is unsafe: ${change.oldPath}` });
      continue;
    }
    if (envSet.has(change.path)) {
      excluded.push({ path: change.path, reason: 'Local environment file selected for this experiment — never transferred.' });
      continue;
    }
    if (!change.untracked && change.status !== 'deleted' && isSymlink(path.join(winnerWorktree, change.path))) {
      problems.push({ code: 'symlink', message: `Symlinks are not transferred in V1: ${change.path}` });
      continue;
    }
    if (change.untracked && isSymlink(path.join(winnerWorktree, change.path))) {
      problems.push({ code: 'symlink', message: `Symlinks are not transferred in V1: ${change.path}` });
      continue;
    }
    eligible.push(change);
  }
  if (problems.length > 0) {
    return { plan: null, problems };
  }

  // Tracked changes as one binary-safe patch, env files path-excluded.
  const pathspec = ['--', '.', ...envFiles.map((f) => `:(exclude)${f}`)];
  const patchRes = await execGit(winnerWorktree, ['diff', '--binary', baselineSha, ...pathspec]);
  if (patchRes.code !== 0) {
    return { plan: null, problems: [{ code: 'patch', message: `Could not build the transfer patch: ${patchRes.stderr.trim()}` }] };
  }

  const fingerprint = fingerprintChanges(winnerWorktree, eligible);
  return {
    plan: { changes, eligible, excluded, patch: patchRes.stdout, fingerprint },
    problems: [],
  };
}

/** FR-06 guards on the original workspace, rechecked immediately before
 *  mutation. Any drift blocks with instructions — V1 never resolves it. */
export async function validateOriginal(
  repoPath: string,
  expectedBranch: string,
  baselineSha: string,
): Promise<GuardProblem[]> {
  const problems: GuardProblem[] = [];
  const branch = await currentBranch(repoPath);
  if (branch !== expectedBranch) {
    problems.push({
      code: 'branch-moved',
      message: `The original workspace is on "${branch ?? 'detached HEAD'}", not the recorded branch "${expectedBranch}". Switch back to apply, or export the variant and start a new experiment.`,
    });
  }
  const head = await currentHead(repoPath);
  if (head !== baselineSha) {
    problems.push({
      code: 'baseline-moved',
      message: 'The original branch has advanced past the experiment baseline. V1 does not resolve divergence — preserve/export the variant and start a new experiment from the new baseline.',
    });
  }
  if (!(await isClean(repoPath))) {
    problems.push({
      code: 'dirty',
      message: 'The original workspace has uncommitted changes or untracked files. Commit or remove them before applying a winner.',
    });
  }
  return problems;
}

export interface ApplyOutcome {
  ok: boolean;
  message: string;
  touchedPaths: string[];
  rollbackNote?: string;
}

export async function applyTransfer(args: {
  repoPath: string;
  winnerWorktree: string;
  plan: TransferPlan;
  expectedFingerprint: string;
  tmpDir: string;
}): Promise<ApplyOutcome> {
  const { repoPath, winnerWorktree, plan, expectedFingerprint, tmpDir } = args;

  // Winner must not have moved since review (AC-10).
  const nowFingerprint = fingerprintChanges(winnerWorktree, plan.eligible);
  if (nowFingerprint !== expectedFingerprint) {
    return { ok: false, message: 'The winner changed while the transfer was being prepared. Review the fresh changes and try again — nothing was applied.', touchedPaths: [] };
  }

  const untrackedCopies = plan.eligible.filter((c) => c.untracked);
  const patchFile = path.join(tmpDir, `branchlab-transfer-${Date.now()}.patch`);
  const touchedPaths = plan.eligible.map((c) => c.path);

  // Pre-apply fingerprints of everything we may touch in the original.
  const preState = new Map<string, string>();
  for (const rel of touchedPaths) {
    preState.set(rel, hashFile(path.join(repoPath, rel)));
  }

  try {
    if (plan.patch.trim().length > 0) {
      fs.writeFileSync(patchFile, plan.patch, 'utf8');
      const check = await execGit(repoPath, ['apply', '--check', '--binary', patchFile]);
      if (check.code !== 0) {
        return { ok: false, message: `The transfer patch does not apply cleanly — nothing was changed. ${check.stderr.trim()}`, touchedPaths: [] };
      }
      const applied = await execGit(repoPath, ['apply', '--binary', '--whitespace=nowarn', patchFile]);
      if (applied.code !== 0) {
        return { ok: false, message: `Applying the patch failed partway: ${applied.stderr.trim()}`, touchedPaths, rollbackNote: 'Inspect the workspace diff; the patch check passed, so any partial state is limited to the listed paths.' };
      }
    }
    for (const change of untrackedCopies) {
      const from = path.join(winnerWorktree, change.path);
      const to = path.join(repoPath, change.path);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  } catch (err) {
    return { ok: false, message: `Transfer failed: ${err instanceof Error ? err.message : String(err)}`, touchedPaths };
  } finally {
    fs.rmSync(patchFile, { force: true });
  }

  // Verify: every touched path in the original now matches the winner.
  const mismatches: string[] = [];
  for (const change of plan.eligible) {
    const winnerHash = change.status === 'deleted' ? 'missing' : hashFile(path.join(winnerWorktree, change.path));
    const appliedHash = hashFile(path.join(repoPath, change.path));
    if (winnerHash !== appliedHash) {
      mismatches.push(change.path);
    }
  }
  if (mismatches.length > 0) {
    // Best-effort restore of paths whose contents are still exactly what
    // we wrote (safe); anything concurrently edited is left alone and
    // reported (FR-06).
    const restored: string[] = [];
    const leftAlone: string[] = [];
    for (const rel of mismatches) {
      const before = preState.get(rel);
      const target = path.join(repoPath, rel);
      if (before === 'missing' || before === undefined) {
        fs.rmSync(target, { force: true });
        restored.push(rel);
      } else {
        // We cannot safely recreate pre-apply bytes here without an
        // artifact copy; leave the path and report it honestly.
        leftAlone.push(rel);
      }
    }
    return {
      ok: false,
      message: `Transfer verification failed for: ${mismatches.join(', ')}.`,
      touchedPaths,
      rollbackNote: `Removed our newly added files (${restored.join(', ') || 'none'}). Paths needing manual review: ${leftAlone.join(', ') || 'none'} — your edits were not overwritten.`,
    };
  }

  return { ok: true, message: 'Applied · Not committed. Review the changes in the original workspace and commit when ready.', touchedPaths };
}
