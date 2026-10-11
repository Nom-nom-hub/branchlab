import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { __commands, __setWorkspaceFolder } from './vscodeMock.js';
import { makeRepo, headSha, type FixtureRepo } from './repoHelper.js';
import { Store } from '../store.js';
import { createExperiment } from '../experiments.js';

let fixture: FixtureRepo | null = null;
let storageDir = '';
afterEach(() => {
  fixture?.cleanup();
  fixture = null;
  if (storageDir) {
    fs.rmSync(storageDir, { recursive: true, force: true });
    storageDir = '';
  }
  __setWorkspaceFolder(null);
});

describe('extension activation', () => {
  it('activates against a fixture repo, registers commands, and reconciles stored experiments', async () => {
    fixture = await makeRepo();
    storageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'branchlab-host-'));
    __setWorkspaceFolder(fixture.dir);

    // Seed an experiment through the service, as a previous session would.
    const store = new Store(storageDir);
    store.load();
    const { experiment } = await createExperiment(store, {
      title: 'Seeded',
      repo: { root: fixture.dir, branch: 'main', headSha: await headSha(fixture.dir) },
      appRoot: fixture.dir, adapter: 'vite', packageManager: 'npm',
      variants: [{ label: 'A', brief: '' }, { label: 'B', brief: '' }],
      envFiles: [], testCommand: null,
      worktreeBase: path.join(storageDir, 'worktrees'),
    });
    expect(experiment.state).toBe('active');

    const ext = await import('../extension.js');
    const context = {
      subscriptions: [] as { dispose: () => void }[],
      globalStorageUri: { fsPath: storageDir, scheme: 'file' },
      extensionUri: { fsPath: process.cwd(), scheme: 'file' },
    };
    await ext.activate(context as never);
    for (const id of ['branchlab.newExperiment', 'branchlab.openPanel', 'branchlab.refresh', 'branchlab.openVariant', 'branchlab.archiveExperiment', 'branchlab.deleteExperiment']) {
      expect(__commands.has(id), id).toBe(true);
    }
    ext.deactivate();
  });
});
