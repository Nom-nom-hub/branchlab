/** Change computation: the complete set from the pinned baseline to a
 *  variant's current working state (FR-05) — staged, unstaged, committed-
 *  after-baseline, additions, deletions, renames, and eligible untracked
 *  files. Ignored content never appears (git excludes it by construction). */
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execGit } from './git.js';

export interface ChangeEntry {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  oldPath?: string;
  binary: boolean;
  untracked: boolean;
}

function looksBinary(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(4096);
    const read = fs.readSync(fd, buf, 0, 4096, 0);
    fs.closeSync(fd);
    for (let i = 0; i < read; i++) {
      if (buf[i] === 0) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export async function computeChanges(worktree: string, baselineSha: string): Promise<ChangeEntry[]> {
  const changes: ChangeEntry[] = [];

  // Binary flags from numstat ("-\t-" marks binary files).
  const numstat = await execGit(worktree, ['diff', '--numstat', '-z', baselineSha, '--']);
  const binaryPaths = new Set<string>();
  if (numstat.code === 0) {
    for (const record of numstat.stdout.split('\0')) {
      const m = /^-\t-\t(.+)$/s.exec(record);
      if (m) {
        binaryPaths.add(m[1]!);
      }
    }
  }

  const nameStatus = await execGit(worktree, [
    'diff', '--name-status', '-z', '--find-renames', baselineSha, '--',
  ]);
  if (nameStatus.code === 0) {
    const fields = nameStatus.stdout.split('\0').filter((f) => f.length > 0);
    for (let i = 0; i < fields.length; i++) {
      const code = fields[i]!;
      const letter = code[0];
      if (letter === 'R' || letter === 'C') {
        const oldPath = fields[++i]!;
        const newPath = fields[++i]!;
        changes.push({ path: newPath, oldPath, status: 'renamed', binary: binaryPaths.has(newPath), untracked: false });
      } else {
        const p = fields[++i]!;
        const status = letter === 'A' ? 'added' : letter === 'D' ? 'deleted' : 'modified';
        changes.push({ path: p, status, binary: binaryPaths.has(p), untracked: false });
      }
    }
  }

  const untracked = await execGit(worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  if (untracked.code === 0) {
    for (const p of untracked.stdout.split('\0').filter((f) => f.length > 0)) {
      changes.push({
        path: p,
        status: 'added',
        binary: looksBinary(path.join(worktree, p)),
        untracked: true,
      });
    }
  }
  changes.sort((a, b) => a.path.localeCompare(b.path));
  return changes;
}

/** sha256 of a file's bytes, or 'missing'. */
export function hashFile(absPath: string): string {
  try {
    return crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');
  } catch {
    return 'missing';
  }
}

/** Content fingerprint over a change set: paths + per-file hashes. Any
 *  edit, addition, or deletion moves it — this is what makes test
 *  results go stale (FR-05) and what proves a winner did not change
 *  mid-transfer (FR-06). */
export function fingerprintChanges(root: string, changes: ChangeEntry[]): string {
  const hash = crypto.createHash('sha256');
  for (const change of changes) {
    hash.update(change.status);
    hash.update('|');
    hash.update(change.path);
    hash.update('|');
    if (change.status !== 'deleted') {
      hash.update(hashFile(path.join(root, change.path)));
    } else {
      hash.update('deleted');
    }
    hash.update('\n');
  }
  return hash.digest('hex');
}
