/** ExperimentService (PRD §8): lifecycle, ownership, journal, recovery.
 *  Creation is journaled BEFORE the first mutation; a partial create
 *  leaves a recoverable record and cleanup only ever touches resources
 *  the journal proves BranchLab created (FR-01, FR-07). */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  createWorktree, removeWorktree, deleteBranch, listWorktrees,
  type RepoInfo,
} from './git.js';
import { computeChanges } from './diff.js';
import {
  branchNameFor, canTransition, createId,
  type ExperimentRecord, type VariantRecord,
} from './model.js';
import type { Store } from './store.js';

export interface CreateRequest {
  title: string;
  repo: RepoInfo;
  appRoot: string;
  adapter: 'vite' | 'next';
  packageManager: 'npm' | 'pnpm' | 'yarn';
  variants: { label: string; brief: string }[];
  envFiles: string[];
  testCommand: string | null;
  /** Directory under which variant worktrees live (extension storage). */
  worktreeBase: string;
}

export async function createExperiment(
  store: Store,
  req: CreateRequest,
): Promise<{ experiment: ExperimentRecord; error?: string }> {
  const experimentId = createId('e');
  const variants: VariantRecord[] = req.variants.map((v) => {
    const id = createId('v');
    return {
      id,
      label: v.label,
      brief: v.brief,
      branch: branchNameFor(experimentId, id),
      worktreePath: path.join(req.worktreeBase, experimentId, id),
      setupState: 'created',
      serverState: 'stopped',
      port: null,
      url: null,
      reachableError: false,
      lastError: null,
    };
  });
  const experiment: ExperimentRecord = {
    schemaVersion: 1,
    id: experimentId,
    title: req.title,
    repoPath: req.repo.root,
    repoId: req.repo.root,
    originalBranch: req.repo.branch,
    baselineSha: req.repo.headSha,
    appRoot: req.appRoot,
    adapter: req.adapter,
    packageManager: req.packageManager,
    variants,
    envFiles: req.envFiles,
    testCommand: req.testCommand,
    createdAt: Date.now(),
    state: 'creating',
    lastError: null,
  };

  const opId = createId('op');
  store.startJournal({
    opId, kind: 'create', experimentId, startedAt: Date.now(), completedSteps: [], finished: false,
  });
  store.upsertExperiment(experiment);

  try {
    for (const variant of variants) {
      fs.mkdirSync(path.dirname(variant.worktreePath), { recursive: true });
      const res = await createWorktree(req.repo.root, {
        branch: variant.branch,
        path: variant.worktreePath,
        sha: req.repo.headSha, // pinned once — never re-read (FR-01)
      });
      if (res.code !== 0) {
        throw new Error(`git worktree add failed for "${variant.label}": ${res.stderr.trim()}`);
      }
      store.updateJournal(opId, (j) => j.completedSteps.push(`worktree:${variant.id}`));
      // Explicit env-file copies (paths only in metadata — FR-03).
      for (const rel of req.envFiles) {
        const from = path.join(req.repo.root, rel);
        const to = path.join(variant.worktreePath, rel);
        if (fs.existsSync(from)) {
          fs.mkdirSync(path.dirname(to), { recursive: true });
          fs.copyFileSync(from, to);
        }
      }
    }
    experiment.state = 'active';
    store.upsertExperiment(experiment);
    store.updateJournal(opId, (j) => { j.finished = true; });
    return { experiment };
  } catch (err) {
    experiment.state = 'error';
    experiment.lastError = err instanceof Error ? err.message : String(err);
    store.upsertExperiment(experiment);
    return { experiment, error: experiment.lastError };
  }
}

/** Remove only the worktrees/branches a create journal recorded, after a
 *  partial failure. Never touches anything else (FR-01). */
export async function cleanupPartialCreate(store: Store, experimentId: string): Promise<void> {
  const data = store.get();
  const experiment = data.experiments.find((e) => e.id === experimentId);
  if (!experiment) {
    return;
  }
  const journal = data.journal.find((j) => j.kind === 'create' && j.experimentId === experimentId && !j.finished);
  const made = new Set((journal?.completedSteps ?? []).filter((s) => s.startsWith('worktree:')).map((s) => s.slice('worktree:'.length)));
  for (const variant of experiment.variants) {
    if (!made.has(variant.id)) {
      continue;
    }
    await removeWorktree(experiment.repoPath, variant.worktreePath).catch(() => undefined);
    await deleteBranch(experiment.repoPath, variant.branch).catch(() => undefined);
    await removeTree(variant.worktreePath);
  }
  store.removeExperiment(experimentId);
}

/** Reconcile stored state with reality after a reload (FR-07): variants
 *  whose worktree vanished become "missing"; servers are NEVER
 *  auto-restarted — a running state from a dead session becomes stopped. */
export async function reconcile(store: Store): Promise<void> {
  const data = store.get();
  for (const experiment of data.experiments) {
    if (experiment.state === 'archived') {
      continue;
    }
    const trees = await listWorktrees(experiment.repoPath).catch(() => []);
    const known = new Set(trees.map((t) => path.normalize(t.path)));
    let changed = false;
    for (const variant of experiment.variants) {
      if (!known.has(path.normalize(variant.worktreePath)) || !fs.existsSync(variant.worktreePath)) {
        if (variant.serverState !== 'missing') {
          variant.serverState = 'missing';
          changed = true;
        }
      } else if (variant.serverState === 'running' || variant.serverState === 'starting') {
        variant.serverState = 'stopped';
        changed = true;
      }
    }
    if (changed) {
      store.upsertExperiment(experiment);
    }
  }
}

/** Does a variant hold work beyond the baseline (edits or commits)?
 *  Deletion asks before discarding any of it (FR-07, AC-12). */
export async function variantHasWork(experiment: ExperimentRecord, variant: VariantRecord): Promise<boolean> {
  if (!fs.existsSync(variant.worktreePath)) {
    return false;
  }
  const changes = await computeChanges(variant.worktreePath, experiment.baselineSha).catch(() => []);
  return changes.length > 0;
}

export interface DeleteOutcome {
  ok: boolean;
  blockedBy?: string[];
  /** Directories Git deregistered but the OS would not delete (locked
   *  files — an editor window, a terminal, a server still releasing
   *  handles). The delete itself succeeded; these are named so the user
   *  can clear them by hand once nothing holds them open. */
  leftovers?: string[];
}

/** Remove a directory tree, tolerating the way Windows releases file
 *  handles asynchronously (a just-stopped dev server, editor watchers):
 *  retry with backoff, and report failure as a boolean instead of
 *  throwing the raw OS error through the caller. */
export async function removeTree(dir: string): Promise<boolean> {
  try {
    await fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 });
  } catch {
    /* the existence check below is the verdict */
  }
  return !fs.existsSync(dir);
}

export async function deleteExperiment(
  store: Store,
  experiment: ExperimentRecord,
  opts: { discardConfirmed: boolean; stopServer: (variantId: string) => Promise<void> },
): Promise<DeleteOutcome> {
  if (!opts.discardConfirmed) {
    const holders: string[] = [];
    for (const variant of experiment.variants) {
      if (await variantHasWork(experiment, variant)) {
        holders.push(variant.label);
      }
    }
    if (holders.length > 0) {
      return { ok: false, blockedBy: holders };
    }
  }
  const leftovers: string[] = [];
  for (const variant of experiment.variants) {
    await opts.stopServer(variant.id);
    // A killed server tree releases its file handles asynchronously on
    // Windows; give it a beat before touching the directory.
    await new Promise((resolve) => setTimeout(resolve, 350));
    if (fs.existsSync(variant.worktreePath)) {
      // --force is used ONLY when the user explicitly confirmed
      // discarding this variant's work (checked above or passed in).
      const res = await removeWorktree(experiment.repoPath, variant.worktreePath, opts.discardConfirmed);
      if (res.code !== 0) {
        // Only force at the filesystem level for directories Git no
        // longer tracks; a tracked worktree that refuses removal stops
        // the delete rather than being ripped out.
        const trees = await listWorktrees(experiment.repoPath).catch(() => []);
        if (trees.some((t) => path.normalize(t.path) === path.normalize(variant.worktreePath))) {
          return { ok: false, blockedBy: [`${variant.label}: git worktree remove failed — ${res.stderr.trim()}`] };
        }
        if (!(await removeTree(variant.worktreePath))) {
          leftovers.push(variant.worktreePath);
        }
      }
    }
    await deleteBranch(experiment.repoPath, variant.branch).catch(() => undefined);
  }
  store.removeExperiment(experiment.id);
  return { ok: true, ...(leftovers.length > 0 ? { leftovers } : {}) };
}

export function archiveExperiment(store: Store, experiment: ExperimentRecord): boolean {
  if (!canTransition(experiment.state, 'archived')) {
    return false;
  }
  experiment.state = 'archived';
  store.upsertExperiment(experiment);
  return true;
}
