/** RepositoryService (PRD §8): every Git operation runs with an argument
 *  array and an explicit working directory. Titles, briefs, and paths are
 *  NEVER interpolated into a shell string. This module is vscode-free so
 *  integration tests can drive it against real temporary repositories. */
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function execGit(cwd: string, args: string[], input?: string): Promise<GitResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('git', args, { cwd, shell: false, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (d: string) => { stdout += d; });
    child.stderr.on('data', (d: string) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    if (input !== undefined) {
      child.stdin.end(input);
    } else {
      child.stdin.end();
    }
  });
}

export interface RepoInfo {
  root: string;
  branch: string;
  headSha: string;
}

export interface PreflightProblem {
  code: string;
  message: string;
}

async function gitPath(repo: string, name: string): Promise<string | null> {
  const res = await execGit(repo, ['rev-parse', '--git-path', name]);
  if (res.code !== 0) {
    return null;
  }
  const p = res.stdout.trim();
  return path.isAbsolute(p) ? p : path.join(repo, p);
}

/** Full V1 preflight (FR-01). Returns every problem found — the user gets
 *  the complete list with remedies, not one failure at a time. */
export async function preflight(dir: string): Promise<{ info: RepoInfo | null; problems: PreflightProblem[] }> {
  const problems: PreflightProblem[] = [];
  const top = await execGit(dir, ['rev-parse', '--show-toplevel']).catch(() => null);
  if (!top || top.code !== 0) {
    return { info: null, problems: [{ code: 'not-a-repo', message: 'This folder is not inside a Git repository. Open the repository root and try again.' }] };
  }
  const root = top.stdout.trim();

  const bare = await execGit(root, ['rev-parse', '--is-bare-repository']);
  if (bare.stdout.trim() === 'true') {
    problems.push({ code: 'bare', message: 'Bare repositories are not supported in V1.' });
  }
  const head = await execGit(root, ['rev-parse', '--verify', 'HEAD']);
  if (head.code !== 0) {
    problems.push({ code: 'no-commits', message: 'The repository has no commits yet. Make an initial commit — variants are created from a committed baseline.' });
    return { info: null, problems };
  }
  const headSha = head.stdout.trim();
  const branchRes = await execGit(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  const branch = branchRes.code === 0 ? branchRes.stdout.trim() : '';
  if (!branch) {
    problems.push({ code: 'detached', message: 'HEAD is detached. Check out a branch — BranchLab records the original branch so a winner can be applied back to it.' });
  }

  const status = await execGit(root, ['status', '--porcelain', '--untracked-files=normal']);
  if (status.code === 0 && status.stdout.trim().length > 0) {
    problems.push({ code: 'dirty', message: 'The working tree has uncommitted changes or untracked files. Commit or remove them — variants start from the clean committed baseline, and BranchLab never stashes or commits for you.' });
  }

  for (const [name, label] of [['MERGE_HEAD', 'merge'], ['CHERRY_PICK_HEAD', 'cherry-pick'], ['REVERT_HEAD', 'revert']] as const) {
    const p = await gitPath(root, name);
    if (p && fs.existsSync(p)) {
      problems.push({ code: 'git-op', message: `A Git ${label} is in progress. Finish or abort it before starting an experiment.` });
    }
  }
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const p = await gitPath(root, name);
    if (p && fs.existsSync(p)) {
      problems.push({ code: 'git-op', message: 'A Git rebase is in progress. Finish or abort it before starting an experiment.' });
    }
  }
  if (fs.existsSync(path.join(root, '.gitmodules'))) {
    problems.push({ code: 'submodules', message: 'Repositories with submodules are not supported in V1.' });
  }
  const sparse = await execGit(root, ['config', '--get', 'core.sparseCheckout']);
  if (sparse.stdout.trim() === 'true') {
    problems.push({ code: 'sparse', message: 'Sparse-checkout repositories are not supported in V1.' });
  }

  return { info: problems.length === 0 ? { root, branch, headSha } : { root, branch, headSha }, problems };
}

/** Detect the package manager from the lockfile (FR-03). Ambiguous or
 *  missing → the caller asks the user; never guesses silently. */
export function detectPackageManager(appRoot: string): { pm: 'npm' | 'pnpm' | 'yarn' | null; ambiguous: boolean } {
  const found: Array<'npm' | 'pnpm' | 'yarn'> = [];
  if (fs.existsSync(path.join(appRoot, 'package-lock.json'))) found.push('npm');
  if (fs.existsSync(path.join(appRoot, 'pnpm-lock.yaml'))) found.push('pnpm');
  if (fs.existsSync(path.join(appRoot, 'yarn.lock'))) found.push('yarn');
  if (found.length === 1) {
    return { pm: found[0]!, ambiguous: false };
  }
  return { pm: null, ambiguous: found.length > 1 };
}

export interface WorktreeEntry {
  path: string;
  head: string;
  branch: string | null;
}

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const res = await execGit(repo, ['worktree', 'list', '--porcelain']);
  if (res.code !== 0) {
    return [];
  }
  const entries: WorktreeEntry[] = [];
  let current: Partial<WorktreeEntry> = {};
  const flush = () => {
    if (current.path) {
      entries.push({ path: current.path, head: current.head ?? '', branch: current.branch ?? null });
    }
    current = {};
  };
  for (const line of res.stdout.split('\n')) {
    if (line.startsWith('worktree ')) {
      flush();
      current.path = line.slice('worktree '.length).trim();
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length).trim();
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length).trim().replace('refs/heads/', '');
    } else if (line === '') {
      flush();
    }
  }
  flush();
  return entries;
}

export async function createWorktree(repo: string, args: { branch: string; path: string; sha: string }): Promise<GitResult> {
  return execGit(repo, ['worktree', 'add', '-b', args.branch, args.path, args.sha]);
}

export async function removeWorktree(repo: string, worktreePath: string, force = false): Promise<GitResult> {
  const args = ['worktree', 'remove'];
  if (force) {
    args.push('--force');
  }
  args.push(worktreePath);
  return execGit(repo, args);
}

export async function deleteBranch(repo: string, branch: string): Promise<GitResult> {
  return execGit(repo, ['branch', '-D', branch]);
}

export async function currentHead(repo: string): Promise<string | null> {
  const res = await execGit(repo, ['rev-parse', '--verify', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function currentBranch(repo: string): Promise<string | null> {
  const res = await execGit(repo, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return res.code === 0 ? res.stdout.trim() : null;
}

export async function isClean(repo: string): Promise<boolean> {
  const res = await execGit(repo, ['status', '--porcelain', '--untracked-files=normal']);
  return res.code === 0 && res.stdout.trim().length === 0;
}
