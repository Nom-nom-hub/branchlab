/** BranchLab data model (PRD §7). Records live in extension-managed local
 *  storage — never in repository files. No environment-file contents,
 *  tokens, or browser state are ever recorded here. */

export type ExperimentState =
  | 'creating' | 'active' | 'applying' | 'applied' | 'archived' | 'error';

export type SetupState = 'created' | 'installing' | 'installed' | 'install-error';
export type ServerState = 'stopped' | 'starting' | 'running' | 'error' | 'missing';
export type TestStatus = 'not-configured' | 'never-run' | 'passed' | 'failed' | 'stale' | 'running';

export interface VariantRecord {
  id: string;
  label: string;
  brief: string;
  branch: string;
  worktreePath: string;
  setupState: SetupState;
  serverState: ServerState;
  /** Last allocated loopback port (rechecked at every start). */
  port: number | null;
  url: string | null;
  reachableError: boolean;
  lastError: string | null;
}

export interface TestRunRecord {
  id: string;
  variantId: string;
  command: string;
  /** Content fingerprint of the variant when the run started. A later
   *  change makes the result stale. */
  fingerprint: string;
  startedAt: number;
  endedAt: number | null;
  exitCode: number | null;
  status: 'running' | 'passed' | 'failed';
}

export interface ExperimentRecord {
  schemaVersion: 1;
  id: string;
  title: string;
  repoPath: string;
  repoId: string;
  originalBranch: string;
  baselineSha: string;
  appRoot: string;
  adapter: 'vite' | 'next';
  packageManager: 'npm' | 'pnpm' | 'yarn';
  variants: VariantRecord[];
  /** Repo-relative paths of local environment files the user chose to
   *  copy into each worktree. Paths only — never contents. */
  envFiles: string[];
  testCommand: string | null;
  createdAt: number;
  state: ExperimentState;
  lastError: string | null;
}

export interface JournalEntry {
  opId: string;
  kind: 'create' | 'delete' | 'apply';
  experimentId: string;
  startedAt: number;
  /** Steps completed so far — recovery reads this, never guesses. */
  completedSteps: string[];
  finished: boolean;
}

/** Internal IDs: generated, filesystem- and branch-safe. User-provided
 *  names never appear in branch names or paths (PRD FR-01). */
export function createId(prefix: string, random: () => number = Math.random): string {
  const rand = Math.floor(random() * 0xffffffff).toString(36);
  const time = Date.now().toString(36);
  return `${prefix}${time}${rand}`.replace(/[^a-z0-9]/gi, '').toLowerCase();
}

export function branchNameFor(experimentId: string, variantId: string): string {
  return `branchlab/${experimentId}/${variantId}`;
}

/** Legal experiment lifecycle transitions (PRD §7). */
const TRANSITIONS: Record<ExperimentState, ExperimentState[]> = {
  creating: ['active', 'error'],
  active: ['applying', 'archived', 'error'],
  applying: ['applied', 'active', 'error'],
  applied: ['archived'],
  archived: [],
  error: ['archived'],
};

export function canTransition(from: ExperimentState, to: ExperimentState): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false;
}

/** Test status derived from the run record and the variant's current
 *  fingerprint. No run + a configured command = never-run; no command =
 *  not-configured (never "passed"). */
export function testStatusFor(
  experiment: ExperimentRecord,
  runs: TestRunRecord[],
  variantId: string,
  currentFingerprint: string | null,
): TestStatus {
  if (!experiment.testCommand) {
    return 'not-configured';
  }
  const run = [...runs].reverse().find((r) => r.variantId === variantId);
  if (!run) {
    return 'never-run';
  }
  if (run.status === 'running') {
    return 'running';
  }
  if (currentFingerprint !== null && currentFingerprint !== run.fingerprint) {
    return 'stale';
  }
  return run.status;
}
