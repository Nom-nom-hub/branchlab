/** BranchLab host: commands, flows, and coordination. All Git/process
 *  work lives in the vscode-free services; this file owns VS Code
 *  interaction, guards that need editor state (trust, unsaved buffers),
 *  and message routing from the comparison panel. */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { preflight, execGit, detectPackageManager } from './git.js';
import { computeChanges, fingerprintChanges } from './diff.js';
import { inspectApp, installCommand, devCommand, splitCommand, type AdapterId } from './adapters.js';
import { pickPort } from './ports.js';
import { Supervisor, waitReady } from './processes.js';
import { Store } from './store.js';
import {
  createExperiment, cleanupPartialCreate, reconcile, deleteExperiment, archiveExperiment,
} from './experiments.js';
import { buildTransferPlan, validateOriginal, applyTransfer } from './transfer.js';
import { testStatusFor, type ExperimentRecord, type VariantRecord } from './model.js';
import { ComparisonPanel, type PanelPayload } from './panel.js';
import { ExperimentTreeProvider, type ExperimentItem, type VariantItem } from './tree.js';
import type { PanelMessage } from './messages.js';

let store: Store;
let supervisor: Supervisor;
let panel: ComparisonPanel;
let tree: ExperimentTreeProvider;
let selectedExperimentId: string | null = null;
let currentRoute = '/';
const logChannels = new Map<string, vscode.OutputChannel>();
const cancelTokens = new Map<string, { cancelled: boolean }>();
const startRetries = new Map<string, number>();
const watchers: vscode.Disposable[] = [];
let refreshTimer: ReturnType<typeof setTimeout> | null = null;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  store = new Store(context.globalStorageUri.fsPath);
  store.load();
  if (store.corrupt) {
    void vscode.window.showWarningMessage(
      'BranchLab: the local session file could not be read and was started empty. Existing worktrees were not touched.',
    );
  }
  supervisor = new Supervisor();
  supervisor.onServerExit = (key, code) => {
    void onServerExit(key, code);
  };
  tree = new ExperimentTreeProvider(() => store);
  context.subscriptions.push(vscode.window.registerTreeDataProvider('branchlab.experiments', tree));

  panel = new ComparisonPanel(context.extensionUri, (msg) => {
    void handlePanelMessage(context, msg);
  });

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider('branchlab-baseline', baselineProvider),
    vscode.commands.registerCommand('branchlab.newExperiment', () => newExperimentFlow(context)),
    vscode.commands.registerCommand('branchlab.openPanel', (id?: string) => {
      if (typeof id === 'string') {
        selectedExperimentId = id;
      }
      panel.show();
      void refreshAll();
    }),
    vscode.commands.registerCommand('branchlab.refresh', () => refreshAll()),
    vscode.commands.registerCommand('branchlab.openVariant', (item?: VariantItem) => {
      if (item?.variant) {
        void vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(item.variant.worktreePath), { forceNewWindow: true });
      }
    }),
    vscode.commands.registerCommand('branchlab.archiveExperiment', async (item?: ExperimentItem) => {
      const exp = item?.experiment ?? (await pickExperiment('Archive which experiment?'));
      if (exp) {
        // Stop owned servers first — archiving never leaves processes behind.
        for (const v of exp.variants) {
          await supervisor.stopServer(v.id);
        }
        if (archiveExperiment(store, exp)) {
          void refreshAll();
        }
      }
    }),
    vscode.commands.registerCommand('branchlab.deleteExperiment', async (item?: ExperimentItem) => {
      const exp = item?.experiment ?? (await pickExperiment('Delete which experiment?'));
      if (exp) {
        await deleteFlow(exp);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void refreshAll()),
    { dispose: () => void supervisor.stopAll() },
  );

  await reconcile(store);
  const unfinished = store.unfinishedJournal();
  if (unfinished.length > 0) {
    void vscode.window.showWarningMessage(
      `BranchLab recovered ${unfinished.length} interrupted operation(s). Affected experiments are marked in the BranchLab view; nothing was deleted or restarted automatically.`,
    );
  }
  syncWatchers();
  await refreshAll();
}

export function deactivate(): void {
  void supervisor?.stopAll();
}

/* ------------------------------- selection ------------------------------- */

function currentExperiment(): ExperimentRecord | null {
  const data = store.get();
  if (selectedExperimentId) {
    const chosen = data.experiments.find((e) => e.id === selectedExperimentId);
    if (chosen) {
      return chosen;
    }
  }
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  const forRepo = data.experiments.find(
    (e) => e.state !== 'archived' && folder && path.normalize(e.repoPath) === path.normalize(folder),
  );
  return forRepo ?? data.experiments.find((e) => e.state !== 'archived') ?? null;
}

async function pickExperiment(placeHolder: string): Promise<ExperimentRecord | null> {
  const exps = store.get().experiments;
  if (exps.length === 0) {
    return null;
  }
  const pick = await vscode.window.showQuickPick(
    exps.map((e) => ({ label: e.title, description: e.state, id: e.id })),
    { placeHolder },
  );
  return exps.find((e) => e.id === pick?.id) ?? null;
}

function findVariant(variantId: string): { exp: ExperimentRecord; variant: VariantRecord } | null {
  for (const exp of store.get().experiments) {
    const variant = exp.variants.find((v) => v.id === variantId);
    if (variant) {
      return { exp, variant };
    }
  }
  return null;
}

/* -------------------------------- refresh -------------------------------- */

function scheduleRefresh(): void {
  if (refreshTimer) {
    clearTimeout(refreshTimer);
  }
  refreshTimer = setTimeout(() => void refreshAll(), 700);
}

async function refreshAll(): Promise<void> {
  tree.refresh();
  if (panel.visible) {
    const exp = currentExperiment();
    if (exp) {
      panel.setPorts(exp.variants.map((v) => v.port).filter((p): p is number => p !== null));
    }
    panel.post(await buildPayload());
  }
}

async function buildPayload(): Promise<PanelPayload> {
  const exp = currentExperiment();
  if (!exp) {
    return { experiment: null, variants: [] };
  }
  const data = store.get();
  const variants = [];
  for (const variant of exp.variants) {
    let changedCount = 0;
    let fingerprint: string | null = null;
    try {
      const changes = await computeChanges(variant.worktreePath, exp.baselineSha);
      changedCount = changes.length;
      fingerprint = fingerprintChanges(variant.worktreePath, changes);
    } catch {
      changedCount = 0;
    }
    const lastRun = [...data.testRuns].reverse().find((r) => r.variantId === variant.id);
    variants.push({
      id: variant.id,
      label: variant.label,
      brief: variant.brief,
      setupState: variant.setupState,
      serverState: variant.serverState,
      testStatus: testStatusFor(exp, data.testRuns, variant.id, fingerprint),
      testExit: lastRun?.exitCode ?? null,
      port: variant.port,
      url: variant.url,
      changedCount,
      lastError: variant.lastError,
      reachableError: variant.reachableError,
    });
  }
  return {
    experiment: {
      id: exp.id,
      title: exp.title,
      branch: exp.originalBranch,
      baselineShort: exp.baselineSha.slice(0, 10),
      state: exp.state,
      adapter: exp.adapter,
      packageManager: exp.packageManager,
      testCommand: exp.testCommand,
    },
    variants,
  };
}

function syncWatchers(): void {
  for (const w of watchers.splice(0)) {
    w.dispose();
  }
  const exp = currentExperiment();
  if (!exp) {
    return;
  }
  for (const variant of exp.variants) {
    if (!fs.existsSync(variant.worktreePath)) {
      continue;
    }
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(vscode.Uri.file(variant.worktreePath), '**/*'),
    );
    const onEvent = (uri: vscode.Uri) => {
      if (!uri.fsPath.includes('node_modules') && !uri.fsPath.includes(`${path.sep}.git${path.sep}`)) {
        scheduleRefresh();
      }
    };
    watcher.onDidChange(onEvent);
    watcher.onDidCreate(onEvent);
    watcher.onDidDelete(onEvent);
    watchers.push(watcher);
  }
}

/* ------------------------------ server control ---------------------------- */

function portRange(): { start: number; end: number } {
  const cfg = vscode.workspace.getConfiguration('branchlab');
  return {
    start: cfg.get<number>('portRangeStart', 4300),
    end: cfg.get<number>('portRangeEnd', 4399),
  };
}

async function onServerExit(key: string, code: number | null): Promise<void> {
  const found = findVariant(key);
  if (!found) {
    return;
  }
  const { exp, variant } = found;
  if (variant.serverState !== 'starting' && variant.serverState !== 'running') {
    return;
  }
  // Bind race or instant crash during startup: bounded retry on a new
  // port (FR-03), then surface the failure with its logs (AC-05).
  const retries = startRetries.get(key) ?? 0;
  if (variant.serverState === 'starting' && retries < 2) {
    startRetries.set(key, retries + 1);
    variant.lastError = `Server exited during startup (code ${code ?? 'unknown'}) — retrying on another port…`;
    store.upsertExperiment(exp);
    await startServer(exp, variant, true);
    return;
  }
  startRetries.delete(key);
  variant.serverState = code === 0 ? 'stopped' : 'error';
  if (code !== 0) {
    variant.lastError = `Dev server exited with code ${code ?? 'unknown'}. See Logs for its output.`;
  }
  store.upsertExperiment(exp);
  await refreshAll();
}

async function startServer(exp: ExperimentRecord, variant: VariantRecord, isRetry = false): Promise<void> {
  if (variant.serverState === 'missing') {
    void vscode.window.showErrorMessage(`BranchLab: "${variant.label}"'s worktree is missing. Delete the experiment or restore the folder.`);
    return;
  }
  if (variant.setupState !== 'installed') {
    void vscode.window.showInformationMessage(`BranchLab: install dependencies for "${variant.label}" first — its card has the Install button.`);
    return;
  }
  if (!isRetry) {
    startRetries.delete(variant.id);
  }
  const taken = new Set<number>();
  for (const other of exp.variants) {
    if (other.id !== variant.id && other.port) {
      taken.add(other.port);
    }
  }
  if (variant.port) {
    taken.add(variant.port);
  }
  const { start, end } = portRange();
  const port = await pickPort(start, end, taken);
  if (port === null) {
    variant.serverState = 'error';
    variant.lastError = `No free loopback port in the configured range ${start}–${end}. Widen branchlab.portRange in Settings.`;
    store.upsertExperiment(exp);
    await refreshAll();
    return;
  }
  variant.port = port;
  variant.url = `http://127.0.0.1:${port}`;
  variant.serverState = 'starting';
  variant.lastError = null;
  store.upsertExperiment(exp);
  await refreshAll();

  const cmd = devCommand(exp.adapter, exp.packageManager, port);
  const started = supervisor.startServer(variant.id, variant.worktreePath, cmd.command, cmd.args);
  if (!started.ok) {
    variant.serverState = 'error';
    variant.lastError = started.error ?? 'Could not start the dev server.';
    store.upsertExperiment(exp);
    await refreshAll();
    return;
  }
  const ready = await waitReady(port, 45_000);
  const current = findVariant(variant.id);
  if (!current || current.variant.serverState !== 'starting') {
    return; // stopped or crashed meanwhile; the exit handler owns the state
  }
  if (ready.reachable) {
    variant.serverState = 'running';
    variant.reachableError = (ready.status ?? 200) >= 500;
    variant.lastError = variant.reachableError
      ? 'The preview answers but returns an application error. See Logs.'
      : null;
  } else if (supervisor.isRunning(variant.id)) {
    variant.serverState = 'error';
    variant.lastError = 'The dev server process is running but did not answer on its port within 45s. See Logs; Stop ends the process.';
  } else {
    variant.serverState = 'error';
    variant.lastError = 'The dev server exited before becoming ready. See Logs.';
  }
  store.upsertExperiment(exp);
  await refreshAll();
}

async function stopServer(exp: ExperimentRecord, variant: VariantRecord): Promise<void> {
  await supervisor.stopServer(variant.id);
  variant.serverState = 'stopped';
  variant.reachableError = false;
  store.upsertExperiment(exp);
  await refreshAll();
}

/* ---------------------------------- tests --------------------------------- */

async function runTests(exp: ExperimentRecord, variant: VariantRecord): Promise<void> {
  if (!exp.testCommand) {
    void vscode.window.showInformationMessage('BranchLab: no test command is configured for this experiment.');
    return;
  }
  if (cancelTokens.has(variant.id)) {
    return;
  }
  const parsed = splitCommand(exp.testCommand);
  if (!parsed) {
    void vscode.window.showErrorMessage(`BranchLab: could not parse the test command "${exp.testCommand}".`);
    return;
  }
  const changes = await computeChanges(variant.worktreePath, exp.baselineSha);
  const fingerprint = fingerprintChanges(variant.worktreePath, changes);
  const runId = `run${Date.now().toString(36)}`;
  store.addTestRun({
    id: runId, variantId: variant.id, command: exp.testCommand, fingerprint,
    startedAt: Date.now(), endedAt: null, exitCode: null, status: 'running',
  });
  await refreshAll();
  const token = { cancelled: false };
  cancelTokens.set(variant.id, token);
  const result = await supervisor.run(variant.id, variant.worktreePath, parsed.command, parsed.args, {
    timeoutMs: 10 * 60_000,
    token,
  });
  cancelTokens.delete(variant.id);
  const record = store.get().testRuns.find((r) => r.id === runId);
  if (record) {
    record.endedAt = Date.now();
    record.exitCode = result.code;
    record.status = result.code === 0 && !result.cancelled ? 'passed' : 'failed';
    store.save();
  }
  await refreshAll();
}

/* ------------------------------ apply winner ------------------------------ */

function dirtyDocsUnder(dir: string): string[] {
  const out: string[] = [];
  const base = path.normalize(dir) + path.sep;
  for (const doc of vscode.workspace.textDocuments) {
    if (doc.isDirty && doc.uri.scheme === 'file' && path.normalize(doc.uri.fsPath).startsWith(base)) {
      out.push(doc.uri.fsPath);
    }
  }
  return out;
}

async function applyWinnerFlow(exp: ExperimentRecord, variant: VariantRecord): Promise<void> {
  if (exp.state !== 'active') {
    void vscode.window.showInformationMessage(`BranchLab: this experiment is ${exp.state} — a winner can only be applied from an active experiment.`);
    return;
  }
  // Freeze the winner (FR-06): stop its server, require saved buffers.
  await supervisor.stopServer(variant.id);
  const dirty = dirtyDocsUnder(variant.worktreePath);
  if (dirty.length > 0) {
    void vscode.window.showErrorMessage(`BranchLab: save the open files in "${variant.label}" before applying: ${dirty.map((d) => path.basename(d)).join(', ')}`);
    return;
  }
  const { plan, problems } = await buildTransferPlan(variant.worktreePath, exp.baselineSha, exp.envFiles);
  if (!plan) {
    void vscode.window.showErrorMessage(`BranchLab: cannot prepare the transfer — ${problems.map((p) => p.message).join(' ')}`);
    return;
  }
  if (plan.eligible.length === 0) {
    void vscode.window.showInformationMessage(`BranchLab: "${variant.label}" has no eligible changes to apply.`);
    return;
  }
  const data = store.get();
  const changes = await computeChanges(variant.worktreePath, exp.baselineSha);
  const fingerprint = fingerprintChanges(variant.worktreePath, changes);
  const status = testStatusFor(exp, data.testRuns, variant.id, fingerprint);
  const review = [
    `# Apply "${variant.label}" to ${exp.originalBranch}`,
    '',
    `Experiment: ${exp.title} · baseline ${exp.baselineSha.slice(0, 10)}`,
    `Test status: **${status}**${status === 'stale' ? ' — the code changed after the last run' : ''}`,
    '',
    '## Changes that will be applied (as uncommitted changes)',
    ...plan.eligible.map((c) => `- ${c.status}${c.oldPath ? ` ${c.oldPath} →` : ''} \`${c.path}\`${c.binary ? ' (binary)' : ''}${c.untracked ? ' (new file)' : ''}`),
    '',
    ...(plan.excluded.length > 0
      ? ['## Excluded — will NOT transfer', ...plan.excluded.map((e) => `- \`${e.path}\` — ${e.reason}`), '']
      : []),
    'Nothing will be staged or committed. The other variants are not deleted.',
  ].join('\n');
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: review });
  await vscode.window.showTextDocument(doc, { preview: true });
  const confirm = await vscode.window.showWarningMessage(
    `Apply "${variant.label}" to the original workspace (${exp.originalBranch})?`,
    { modal: true, detail: `${plan.eligible.length} change(s) arrive as uncommitted changes. The review document lists exactly what moves and what is excluded.` },
    'Apply Winner',
  );
  if (confirm !== 'Apply Winner') {
    return;
  }
  exp.state = 'applying';
  store.upsertExperiment(exp);
  const guardProblems = await validateOriginal(exp.repoPath, exp.originalBranch, exp.baselineSha);
  if (guardProblems.length > 0) {
    exp.state = 'active';
    store.upsertExperiment(exp);
    void vscode.window.showErrorMessage(`BranchLab: application blocked — ${guardProblems.map((p) => p.message).join(' ')}`);
    await refreshAll();
    return;
  }
  const outcome = await applyTransfer({
    repoPath: exp.repoPath,
    winnerWorktree: variant.worktreePath,
    plan,
    expectedFingerprint: plan.fingerprint,
    tmpDir: os.tmpdir(),
  });
  if (outcome.ok) {
    exp.state = 'applied';
    store.upsertExperiment(exp);
    void vscode.window.showInformationMessage(`BranchLab: ${outcome.message}`);
    await vscode.commands.executeCommand('workbench.view.scm');
  } else {
    exp.state = 'active';
    store.upsertExperiment(exp);
    void vscode.window.showErrorMessage(`BranchLab: ${outcome.message}${outcome.rollbackNote ? ` ${outcome.rollbackNote}` : ''}`);
  }
  await refreshAll();
}

/* --------------------------------- delete --------------------------------- */

async function deleteFlow(exp: ExperimentRecord): Promise<void> {
  const outcome = await deleteExperiment(store, exp, {
    discardConfirmed: false,
    stopServer: (id) => supervisor.stopServer(id).then(() => undefined),
  });
  if (outcome.ok) {
    if (selectedExperimentId === exp.id) {
      selectedExperimentId = null;
    }
    syncWatchers();
    await refreshAll();
    return;
  }
  const holders = outcome.blockedBy ?? [];
  const choice = await vscode.window.showWarningMessage(
    `BranchLab: deleting "${exp.title}" will discard work in: ${holders.join(', ')}.`,
    { modal: true, detail: 'The listed variants contain changes beyond the baseline. Discard them permanently, or cancel and preserve/export the work first (Open the variant and commit it to its branch).' },
    'Discard and Delete',
  );
  if (choice === 'Discard and Delete') {
    const done = await deleteExperiment(store, exp, {
      discardConfirmed: true,
      stopServer: (id) => supervisor.stopServer(id).then(() => undefined),
    });
    if (done.ok) {
      if (selectedExperimentId === exp.id) {
        selectedExperimentId = null;
      }
      syncWatchers();
      await refreshAll();
    } else {
      void vscode.window.showErrorMessage(`BranchLab: delete stopped — ${(done.blockedBy ?? []).join(' ')}`);
    }
  }
}

/* ------------------------------ creation flow ----------------------------- */

async function newExperimentFlow(context: vscode.ExtensionContext): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showErrorMessage('BranchLab: open a folder (your Git repository) first.');
    return;
  }
  if (!vscode.workspace.isTrusted) {
    void vscode.window.showErrorMessage('BranchLab: this workspace is not trusted. BranchLab runs your project\'s own scripts (install, dev, test) and requires Workspace Trust.');
    return;
  }
  const dirtyDocs = vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === 'file');
  const dir = folder.uri.fsPath;

  const check = await preflight(dir);
  const problems = [...check.problems];
  if (dirtyDocs.length > 0) {
    problems.push({ code: 'unsaved', message: `There are unsaved editor buffers (${dirtyDocs.map((d) => path.basename(d.uri.fsPath)).join(', ')}). Save them — variants are created from the committed baseline only.` });
  }
  const existing = store.get().experiments.find(
    (e) => e.state !== 'archived' && path.normalize(e.repoPath) === path.normalize(check.info?.root ?? dir),
  );
  if (existing) {
    problems.push({ code: 'one-active', message: `An experiment ("${existing.title}") is already active for this repository. Archive or delete it first — V1 allows one active experiment per repository.` });
  }
  if (problems.length > 0 || !check.info) {
    const retry = await vscode.window.showErrorMessage(
      `BranchLab can't start yet: ${problems.map((p) => p.message).join(' ')}`,
      { modal: true },
      'Recheck',
    );
    if (retry === 'Recheck') {
      await newExperimentFlow(context);
    }
    return;
  }
  const repo = check.info;

  const app = inspectApp(repo.root);
  if (app.detected.length === 0) {
    void vscode.window.showErrorMessage('BranchLab: no Vite or Next.js app was detected at the repository root (package.json dependencies or config files). V1 supports those two frameworks.');
    return;
  }
  let adapter: AdapterId | undefined = app.adapter ?? undefined;
  if (!adapter) {
    const pick = await vscode.window.showQuickPick(
      app.detected.map((a) => ({ label: a === 'vite' ? 'Vite' : 'Next.js', id: a })),
      { placeHolder: 'Both Vite and Next.js were detected — which runs this app?' },
    );
    adapter = pick?.id as AdapterId | undefined;
    if (!adapter) {
      return;
    }
  }
  const detected = detectPackageManager(repo.root);
  let packageManager = detected.pm;
  if (!packageManager) {
    const pick = await vscode.window.showQuickPick(
      (['npm', 'pnpm', 'yarn'] as const).map((m) => ({ label: m, id: m })),
      { placeHolder: detected.ambiguous ? 'Multiple lockfiles found — which package manager owns this repo?' : 'No lockfile found — which package manager should be used?' },
    );
    if (!pick) {
      return;
    }
    packageManager = pick.id as 'npm' | 'pnpm' | 'yarn';
  }

  const title = await vscode.window.showInputBox({
    prompt: 'Experiment title',
    placeHolder: 'e.g. Dashboard navigation redesign',
    validateInput: (v) => (v.trim().length > 0 ? null : 'A title is required.'),
  });
  if (title === undefined) {
    return;
  }
  const countPick = await vscode.window.showQuickPick(
    [{ label: '2 variants', n: 2 }, { label: '3 variants', n: 3 }],
    { placeHolder: 'How many variants?' },
  );
  if (!countPick) {
    return;
  }
  const letters = ['A', 'B', 'C'];
  const variantInputs: { label: string; brief: string }[] = [];
  const usedLabels = new Set<string>();
  for (let i = 0; i < countPick.n; i++) {
    const label = await vscode.window.showInputBox({
      prompt: `Variant ${letters[i]} — name`,
      value: `Variant ${letters[i]}`,
      validateInput: (v) => {
        const t = v.trim();
        if (!t) return 'A name is required.';
        if (usedLabels.has(t.toLowerCase())) return 'Names must be unique.';
        return null;
      },
    });
    if (label === undefined) {
      return;
    }
    usedLabels.add(label.trim().toLowerCase());
    const brief = await vscode.window.showInputBox({
      prompt: `Variant ${letters[i]} — implementation brief (optional)`,
      placeHolder: 'What should this variant try? It is copied to your coding assistant.',
    });
    if (brief === undefined) {
      return;
    }
    variantInputs.push({ label: label.trim(), brief: brief.trim() });
  }

  // Optional local environment files to copy into every worktree.
  const envCandidates = fs.readdirSync(repo.root).filter((f) => /^\.env(\.|$)/.test(f) && f !== '.env.example');
  let envFiles: string[] = [];
  if (envCandidates.length > 0) {
    const picks = await vscode.window.showQuickPick(
      envCandidates.map((f) => ({ label: f, picked: false })),
      { canPickMany: true, placeHolder: 'Copy any local environment files into each worktree? (contents are never stored or transferred)' },
    );
    envFiles = (picks ?? []).map((p) => p.label);
  }

  const defaultTest = app.hasTestScript ? `${packageManager} test` : '';
  const testCommandInput = await vscode.window.showInputBox({
    prompt: 'Test command run in each variant (leave empty for none)',
    value: defaultTest,
  });
  if (testCommandInput === undefined) {
    return;
  }
  const testCommand = testCommandInput.trim() ? testCommandInput.trim() : null;

  const install = installCommand(packageManager);
  const dev = devCommand(adapter, packageManager, 4300);
  const confirm = await vscode.window.showInformationMessage(
    `BranchLab will create ${countPick.n} worktrees from ${repo.branch} @ ${repo.headSha.slice(0, 10)}. Commands it can run later (only when you click): install "${install.command} ${install.args.join(' ')}", dev "${dev.command} ${dev.args.join(' ').replace('--port 4300', '--port <allocated>').replace('-p 4300', '-p <allocated>')}"${testCommand ? `, test "${testCommand}"` : ''}. The original workspace will not be modified.`,
    { modal: true },
    'Create Experiment',
  );
  if (confirm !== 'Create Experiment') {
    return;
  }

  const { experiment, error } = await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'BranchLab: creating worktrees…' },
    () => createExperiment(store, {
      title: title.trim(),
      repo,
      appRoot: repo.root,
      adapter,
      packageManager,
      variants: variantInputs,
      envFiles,
      testCommand,
      worktreeBase: path.join(context.globalStorageUri.fsPath, 'worktrees'),
    }),
  );
  selectedExperimentId = experiment.id;
  syncWatchers();
  panel.show();
  await refreshAll();
  if (error) {
    const cleanup = await vscode.window.showErrorMessage(
      `BranchLab: creation failed partway — ${error} The partial experiment is preserved for recovery.`,
      'Remove Partial Experiment',
      'Keep It',
    );
    if (cleanup === 'Remove Partial Experiment') {
      await cleanupPartialCreate(store, experiment.id);
      selectedExperimentId = null;
      syncWatchers();
      await refreshAll();
    }
  }
}

/* ------------------------------ panel routing ----------------------------- */

const baselineProvider: vscode.TextDocumentContentProvider = {
  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    // Query: {repo, sha, file} — content served from Git objects only.
    const q = JSON.parse(uri.query) as { repo: string; sha: string; file: string };
    const res = await execGit(q.repo, ['show', `${q.sha}:${q.file}`]);
    return res.code === 0 ? res.stdout : '';
  },
};

function logChannelFor(variant: VariantRecord): vscode.OutputChannel {
  let channel = logChannels.get(variant.id);
  if (!channel) {
    channel = vscode.window.createOutputChannel(`BranchLab · ${variant.label}`);
    logChannels.set(variant.id, channel);
  }
  return channel;
}

async function openFileDiff(exp: ExperimentRecord, variant: VariantRecord, relPath: string): Promise<void> {
  const changes = await computeChanges(variant.worktreePath, exp.baselineSha);
  const change = changes.find((c) => c.path === relPath);
  const fileUri = vscode.Uri.file(path.join(variant.worktreePath, relPath));
  if (!change) {
    await vscode.window.showTextDocument(fileUri);
    return;
  }
  if (change.status === 'added') {
    await vscode.window.showTextDocument(fileUri);
    return;
  }
  const baselineUri = vscode.Uri.from({
    scheme: 'branchlab-baseline',
    path: `/${relPath}`,
    query: JSON.stringify({ repo: variant.worktreePath, sha: exp.baselineSha, file: change.oldPath ?? relPath }),
  });
  if (change.status === 'deleted') {
    const doc = await vscode.workspace.openTextDocument(baselineUri);
    await vscode.window.showTextDocument(doc);
    return;
  }
  await vscode.commands.executeCommand(
    'vscode.diff',
    baselineUri,
    fileUri,
    `${relPath} (baseline ↔ ${variant.label})`,
  );
}

async function handlePanelMessage(context: vscode.ExtensionContext, msg: PanelMessage): Promise<void> {
  if (msg.type === 'ready') {
    await refreshAll();
    return;
  }
  if (msg.type === 'setRoute') {
    currentRoute = msg.route;
    return;
  }
  const exp = currentExperiment();
  if (!exp) {
    return;
  }
  if (msg.type === 'runAllTests') {
    for (const variant of exp.variants) {
      if (variant.serverState !== 'missing') {
        await runTests(exp, variant);
      }
    }
    return;
  }
  const found = findVariant(msg.variantId);
  if (!found) {
    return;
  }
  const { variant } = found;
  switch (msg.type) {
    case 'startServer':
      await startServer(exp, variant);
      break;
    case 'stopServer':
      await stopServer(exp, variant);
      break;
    case 'restartServer':
      await stopServer(exp, variant);
      await startServer(exp, variant);
      break;
    case 'install': {
      if (variant.setupState === 'installing') {
        break;
      }
      variant.setupState = 'installing';
      variant.lastError = null;
      store.upsertExperiment(exp);
      await refreshAll();
      const cmd = installCommand(exp.packageManager);
      const result = await supervisor.run(variant.id, variant.worktreePath, cmd.command, cmd.args, {
        timeoutMs: 20 * 60_000,
      });
      variant.setupState = result.code === 0 ? 'installed' : 'install-error';
      if (result.code !== 0) {
        variant.lastError = `Install failed (exit ${result.code ?? 'unknown'}). See Logs for the package manager's output.`;
      }
      store.upsertExperiment(exp);
      await refreshAll();
      break;
    }
    case 'openVariant':
      await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(variant.worktreePath), { forceNewWindow: true });
      break;
    case 'openInBrowser':
      if (variant.url) {
        await vscode.env.openExternal(vscode.Uri.parse(variant.url.replace(/\/$/, '') + currentRoute));
      }
      break;
    case 'copyBrief': {
      const text = variant.brief
        ? `Implement this variant of "${exp.title}": ${variant.brief}\n\nWork in this folder: ${variant.worktreePath}\nBaseline commit: ${exp.baselineSha}`
        : `Work in this folder: ${variant.worktreePath}\nBaseline commit: ${exp.baselineSha}`;
      await vscode.env.clipboard.writeText(text);
      void vscode.window.showInformationMessage('BranchLab: brief + worktree path copied. Paste it to your coding assistant in the variant window.');
      break;
    }
    case 'showLogs': {
      const channel = logChannelFor(variant);
      channel.clear();
      channel.appendLine(`BranchLab · ${variant.label} — ${variant.branch} — ${variant.worktreePath}`);
      channel.appendLine(supervisor.log(variant.id).get() || '(no output yet)');
      channel.show();
      break;
    }
    case 'showDiff': {
      const changes = await computeChanges(variant.worktreePath, exp.baselineSha);
      if (changes.length === 0) {
        void vscode.window.showInformationMessage(`BranchLab: "${variant.label}" has no changes vs the baseline yet.`);
        break;
      }
      const pick = await vscode.window.showQuickPick(
        changes.map((c) => ({
          label: c.path,
          description: `${c.status}${c.binary ? ' · binary' : ''}${c.untracked ? ' · new' : ''}`,
          path: c.path,
        })),
        { placeHolder: `${variant.label} — ${changes.length} changed file(s) vs baseline` },
      );
      if (pick) {
        await openFileDiff(exp, variant, pick.path);
      }
      break;
    }
    case 'openFileDiff':
      await openFileDiff(exp, variant, msg.path);
      break;
    case 'runTests':
      await runTests(exp, variant);
      break;
    case 'cancelRun': {
      const token = cancelTokens.get(variant.id);
      if (token) {
        token.cancelled = true;
      }
      break;
    }
    case 'applyWinner':
      await applyWinnerFlow(exp, variant);
      break;
  }
  void context;
}
