/** Path guards (PRD FR-06, AC-14). Every path that participates in a
 *  transfer is proven to live inside the repository and outside Git
 *  metadata before anything is read or written. Pure, unit-tested. */
import * as path from 'node:path';

function normalize(p: string, platform: NodeJS.Platform): string {
  const sep = platform === 'win32' ? '\\' : '/';
  let n = p.replace(/[\\/]+/g, sep);
  if (platform === 'win32') {
    n = n.toLowerCase();
  }
  // Resolve . and .. segments lexically.
  const isAbs = n.startsWith(sep) || /^[a-z]:\\/i.test(n);
  const parts = n.split(sep).filter((s) => s !== '' && s !== '.');
  const out: string[] = [];
  for (const part of parts) {
    if (part === '..') {
      out.pop();
    } else {
      out.push(part);
    }
  }
  const drive = platform === 'win32' && /^[a-z]:/i.test(n) ? n.slice(0, 2) : '';
  return (drive + (isAbs && !drive ? sep : drive ? sep : '') + out.join(sep)) || sep;
}

/** True when `candidate` is `root` itself or strictly inside it. */
export function isPathInside(
  root: string,
  candidate: string,
  platform: NodeJS.Platform = process.platform,
): boolean {
  const r = normalize(root, platform);
  const c = normalize(candidate, platform);
  const sep = platform === 'win32' ? '\\' : '/';
  return c === r || c.startsWith(r.endsWith(sep) ? r : r + sep);
}

/** True when any segment of the repo-relative path is Git metadata. */
export function touchesGitMetadata(repoRelativePath: string): boolean {
  return repoRelativePath
    .split(/[\\/]+/)
    .some((seg) => seg === '.git');
}

/** Validate a repo-relative transfer path: non-empty, relative, no
 *  traversal, no Git metadata. Returns the normalized relative path or
 *  null when it must be rejected. */
export function validateRelativePath(repoRelativePath: string): string | null {
  if (!repoRelativePath || repoRelativePath.length > 1024) {
    return null;
  }
  if (path.posix.isAbsolute(repoRelativePath) || path.win32.isAbsolute(repoRelativePath)) {
    return null;
  }
  const parts = repoRelativePath.split(/[\\/]+/).filter((s) => s !== '' && s !== '.');
  if (parts.some((s) => s === '..')) {
    return null;
  }
  const joined = parts.join('/');
  if (!joined || touchesGitMetadata(joined)) {
    return null;
  }
  return joined;
}
