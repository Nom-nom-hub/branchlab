import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execGit } from '../git.js';

export interface FixtureRepo {
  dir: string;
  cleanup: () => void;
}

export async function makeRepo(files: Record<string, string | Buffer> = {}): Promise<FixtureRepo> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchlab-test-'));
  const git = (args: string[]) => execGit(dir, args);
  await git(['init', '-b', 'main']);
  await git(['config', 'user.email', 'test@branchlab.dev']);
  await git(['config', 'user.name', 'BranchLab Test']);
  await git(['config', 'commit.gpgsign', 'false']);
  const defaults: Record<string, string | Buffer> = {
    'package.json': JSON.stringify({ name: 'fixture', scripts: { dev: 'vite', test: 'node test.js' }, dependencies: { vite: '^5.0.0' } }, null, 2),
    'package-lock.json': '{}',
    'src/app.ts': 'export const app = 1;\n',
    '.gitignore': 'node_modules/\n.env.local\n',
    ...files,
  };
  for (const [rel, content] of Object.entries(defaults)) {
    const abs = path.join(dir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  await git(['add', '-A']);
  await git(['commit', '-m', 'baseline']);
  return { dir, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

export function writeFile(root: string, rel: string, content: string | Buffer): void {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content);
}

export async function headSha(dir: string): Promise<string> {
  const res = await execGit(dir, ['rev-parse', 'HEAD']);
  return res.stdout.trim();
}
