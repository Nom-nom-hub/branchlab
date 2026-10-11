import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Store } from '../store.js';
import { createExperiment, reconcile, deleteExperiment, removeTree } from '../experiments.js';
import { makeRepo, writeFile, headSha, type FixtureRepo } from './repoHelper.js';

let fixture: FixtureRepo | null = null;
let base = '';
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  if (base) {
    fs.rmSync(base, { recursive: true, force: true });
    base = '';
  }
});

async function setup(): Promise<{ store: Store }> {
  fixture = await makeRepo();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'branchlab-svc-'));
  const store = new Store(path.join(base, 'storage'));
  store.load();
  return { store };
}

describe('experiment lifecycle', () => {
  it('creates 3 variants at one pinned baseline and journals the create (AC-01)', async () => {
    const { store } = await setup();
    const { experiment, error } = await createExperiment(store, {
      title: 'Nav redesign',
      repo: { root: fixture!.dir, branch: 'main', headSha: (await import('./repoHelper.js')).headSha ? await (await import('./repoHelper.js')).headSha(fixture!.dir) : '' },
      appRoot: fixture!.dir,
      adapter: 'vite',
      packageManager: 'npm',
      variants: [{ label: 'A', brief: '' }, { label: 'B', brief: '' }, { label: 'C', brief: '' }],
      envFiles: [],
      testCommand: null,
      worktreeBase: path.join(base, 'worktrees'),
    });
    expect(error).toBeUndefined();
    expect(experiment.state).toBe('active');
    expect(experiment.variants.length).toBe(3);
    for (const v of experiment.variants) {
      expect(fs.existsSync(path.join(v.worktreePath, 'src/app.ts'))).toBe(true);
    }
    const journal = store.get().journal.find((j) => j.experimentId === experiment.id);
    expect(journal?.finished).toBe(true);
    expect(journal?.completedSteps.length).toBe(3);
    // Store survives a reload.
    const store2 = new Store(path.join(base, 'storage'));
    expect(store2.load().experiments.length).toBe(1);
  });

  it('reconcile marks a vanished worktree missing and never revives servers (FR-07)', async () => {
    const { store } = await setup();
    const { experiment } = await createExperiment(store, {
      title: 'X',
      repo: { root: fixture!.dir, branch: 'main', headSha: await (await import('./repoHelper.js')).headSha(fixture!.dir) },
      appRoot: fixture!.dir, adapter: 'vite', packageManager: 'npm',
      variants: [{ label: 'A', brief: '' }, { label: 'B', brief: '' }],
      envFiles: [], testCommand: null, worktreeBase: path.join(base, 'worktrees'),
    });
    const gone = experiment.variants[0]!;
    gone.serverState = 'running';
    store.upsertExperiment(experiment);
    fs.rmSync(gone.worktreePath, { recursive: true, force: true });
    await reconcile(store);
    const after = store.get().experiments[0]!;
    expect(after.variants[0]!.serverState).toBe('missing');
    expect(after.variants[1]!.serverState).toBe('stopped');
  });

  it('delete blocks on user work, then discards explicitly (AC-12)', async () => {
    const { store } = await setup();
    const { experiment } = await createExperiment(store, {
      title: 'X',
      repo: { root: fixture!.dir, branch: 'main', headSha: await (await import('./repoHelper.js')).headSha(fixture!.dir) },
      appRoot: fixture!.dir, adapter: 'vite', packageManager: 'npm',
      variants: [{ label: 'A', brief: '' }, { label: 'B', brief: '' }],
      envFiles: [], testCommand: null, worktreeBase: path.join(base, 'worktrees'),
    });
    writeFile(experiment.variants[0]!.worktreePath, 'src/app.ts', 'changed\n');
    const blocked = await deleteExperiment(store, experiment, { discardConfirmed: false, stopServer: async () => undefined });
    expect(blocked.ok).toBe(false);
    expect(blocked.blockedBy).toContain('A');
    const done = await deleteExperiment(store, experiment, { discardConfirmed: true, stopServer: async () => undefined });
    expect(done.ok).toBe(true);
    expect(store.get().experiments.length).toBe(0);
    expect(fs.existsSync(experiment.variants[0]!.worktreePath)).toBe(false);
    // The original repo is untouched.
    expect(fs.existsSync(path.join(fixture!.dir, 'src/app.ts'))).toBe(true);
  });
});

describe('removeTree', () => {
  it('removes a populated tree and reports success; a missing path is success too', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchlab-rm-'));
    fs.mkdirSync(path.join(dir, 'node_modules/pkg'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'node_modules/pkg/index.js'), 'x');
    await expect(removeTree(dir)).resolves.toBe(true);
    expect(fs.existsSync(dir)).toBe(false);
    await expect(removeTree(dir)).resolves.toBe(true);
  });
});
