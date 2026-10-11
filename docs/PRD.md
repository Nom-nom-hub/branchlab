# BranchLab — V1 Product Requirements Document

Version: 1.0 · Date: October 11, 2026 · Status: Proposed implementation baseline

## 1. Product definition

BranchLab is a local VS Code extension for developing and comparing alternative implementations of a feature. It creates two or three isolated Git worktrees from the same starting commit, runs their development servers, presents their previews together, and helps the developer apply one chosen implementation to the original workspace.

Product promise: Try alternatives, compare working results, and keep the best implementation without repeatedly switching branches or manually managing development servers.

BranchLab coordinates experiments. Developers implement variants themselves or use an existing coding assistant in each variant workspace. V1 requires no BranchLab account, hosted backend, model subscription, or paid AI API.

## 2. Problem and audience

Trying alternative implementations currently means creating branches, switching contexts, assigning ports, opening browser windows, remembering which result belongs to which change, and transferring the preferred changes back. This overhead encourages developers to accept the first working approach.

Primary users are individual React/TypeScript developers and small teams using VS Code. Secondary users are developers who already use coding agents and want to compare their outputs through running applications.

Initial use cases:

- Compare two or three navigation, dashboard, or form designs.
- Compare pagination, infinite scrolling, and a load-more interaction.
- Compare alternative refactors using the same existing test command.
- Keep a conservative approach alongside a more experimental implementation.

## 3. Goals and success measures

| Goal | V1 measure |
| --- | --- |
| Reduce experiment setup work | For a supported fixture with dependencies already installed, create the worktrees and open the experiment panel in under 10 seconds on the reference development machine; server startup is measured separately. |
| Make alternatives understandable | Every preview, log, test result, and diff visibly identifies its variant. |
| Make choosing useful | A user can inspect a variant diff and transfer its eligible changes through one guided workflow. |
| Protect existing work | The original workspace remains unchanged during creation, editing, comparison, and cancellation. |
| Make recovery reliable | Reloading VS Code restores session metadata and reconciles worktrees and owned processes without automatically launching commands. |

Pilot target: at least 7 of 10 participating developers complete creation, editing, comparison, and winner application without assistance. Treat this as a validation target, not a forecast. Timing excludes package downloads and app compilation. Record reference hardware in release QA.

## 4. Scope decisions

Included in V1:

- Two or three variants from a clean, committed baseline
- One local Git repository and one application root
- React/TypeScript applications using Vite or Next.js through explicit adapters
- npm, pnpm, or Yarn using the repository's existing lockfile
- Side-by-side previews when embedding is supported; browser fallback otherwise
- Per-variant logs, diff, and configured test command
- Reviewed application of one variant's changes
- Local session history and recovery
- Open each variant for manual edits or an existing agent
- Shared relative preview path and viewport presets

Deferred:

- Experiments based on uncommitted or unsaved changes
- Monorepo orchestration, submodules, multiple repositories
- Universal framework detection and arbitrary command adapters
- Package-manager migration or automatic lockfile repair
- Guaranteed embedding of every application
- Automatic test generation and normalized performance rankings
- Combining winners, automatic conflict resolution, publish/deploy
- Shared experiments, accounts, hosted compute
- Built-in agents, automatic prompt execution, agent comparisons
- Mirrored clicks, interaction recording, synchronized app state

V1 is a desktop extension for Windows, macOS, and Linux. VS Code for the Web, Remote SSH, WSL, and development containers are outside the initial support matrix. Limit V1 to one active experiment per repository.

## 5. Core user journey

1. The developer opens a trusted, supported Git workspace and invokes BranchLab: New Experiment.
2. BranchLab checks the repository, clean status, saved editor buffers, app root, package manager, and available tooling.
3. The developer enters an experiment title, chooses two or three variants, and assigns a name and optional implementation brief to each.
4. BranchLab records the current branch and exact HEAD commit, then creates a unique worktree and branch for each variant from that commit.
5. The developer reviews setup and launch commands. BranchLab runs them only after the developer explicitly chooses the corresponding action.
6. The comparison panel shows variant cards with readiness, preview, and actions. Open Variant opens its worktree in a separate VS Code window. Copy Brief provides its implementation brief for an existing agent.
7. The developer edits variants and reviews live previews, logs, diffs, and test outcomes.
8. The developer chooses Apply Winner, reviews the exact eligible changes, and confirms application to the original workspace.
9. BranchLab transfers the changes without committing them. The developer uses normal Git review and commit workflows.
10. The developer archives the experiment or explicitly removes its worktrees. Applying a winner does not silently delete other variants.

## 6. Functional requirements

### FR-01 — Preflight and creation

- Require Workspace Trust, an initialized non-bare Git repository with at least one commit, a supported app root, and installed Git/Node/package-manager tooling.
- Reject a dirty baseline, including non-ignored untracked files and unsaved editor buffers. Offer a clear explanation and recheck action; never auto-stash or auto-commit.
- Reject detached HEAD, active merge/rebase/cherry-pick operations, submodules, and sparse-checkout repositories in V1.
- Require exactly two or three uniquely named variants. Use generated internal IDs rather than user-provided names in branch names and filesystem paths.
- Pin the baseline commit once. All variants must start at that exact commit even if another process changes the original branch during creation.
- Persist a creation journal before mutation. If creation partially fails, preserve recoverable state and offer removal of only the resources created by that attempt.

### FR-02 — Worktree isolation and editing

- Create branches under branchlab/<experiment-id>/<variant-id> and worktrees outside the original source directory in an extension-managed local data location.
- Each variant has its own tracked files, dependency installation, build output, development-server process, and allocated port.
- Do not share node_modules through symlinks in V1. Installation scripts and build artifacts can mutate dependencies and invalidate isolation.
- Explain that Git metadata and repository objects remain shared. Worktrees are not security sandboxes and do not isolate databases, APIs, or other external services.
- Open the selected variant in its own VS Code window; keep the original window as the comparison/control workspace.
- Detect file changes and refresh diff summaries with debouncing. Uncommitted edits and commits made in a variant must both be included in its comparison against the pinned baseline.

### FR-03 — Setup, environment, and execution

- Detect the existing package manager from repository metadata. Ambiguous or incompatible configuration requires a user selection or a blocking explanation.
- Show the exact install, dev, and test commands and working directory before first execution. Do not run package lifecycle scripts on extension activation.
- Require an explicit adapter selection/confirmation for supported Vite and Next.js apps. Adapters pass port and host settings; do not assume setting PORT works for every framework.
- Install dependencies separately per variant, sequentially by default. Show progress, cancellation, exit status, and a retry action. Lockfile-enforced installation must fail rather than silently modify an incompatible lockfile.
- Do not automatically copy ignored files or environment files. Allow explicit per-experiment selection of local environment files, copied directly into each worktree without storing their contents in session metadata or telemetry.
- Warn within the setup flow when selected configuration uses shared external state; document a recommended mock or disposable development environment. BranchLab does not redirect or clone a database.
- Allocate loopback ports from a configurable range, recheck at startup, and use strict binding when supported. If a race causes a bind failure, retry with another port within a bounded limit and update the preview URL.
- Manage one dev-server process tree per variant. Start, stop, and restart are independent. Never kill a process solely because it occupies the desired port.
- Determine readiness with a bounded HTTP check and process state. A preview URL returning an application error may show Reachable · App error; a listening socket alone is insufficient for readiness.

### FR-04 — Comparison interface

- Provide an Activity Bar entry, experiment tree, and comparison webview that inherits VS Code's theme. Support keyboard operation, clear focus indicators, and accessible status labels.
- Each card displays name, brief, state, URL, preview, changed-file count, last test result, and actions: Open, Start/Stop, Logs, Diff, Test, Apply Winner.
- Default to two equal columns for two variants and three for three variants on sufficiently wide panels; allow focused single-variant view on narrow panels.
- Supply common viewport presets and a shared relative route field. Apply the same route to each variant's URL; this is navigation coordination, not synchronization of application state.
- Show isolated origins/state: authentication, cookies, storage, scroll position, and interactions are not guaranteed to match across variants.
- When embedding is blocked by application headers or webview restrictions, preserve the card and offer Open in Browser. Do not strip security headers or claim universal iframe support.
- Never depend on inspecting cross-origin iframe DOM for tests, metrics, or navigation. Embedded previews are display surfaces, not automation targets in V1.

### FR-05 — Diff and tests

- Show the complete change set from baseline to the variant's current working state, including staged and unstaged changes, commits after baseline, file additions, deletions, renames, and eligible untracked files.
- Provide changed-file navigation and VS Code diff views. Display binary changes as summaries rather than invented text diffs.
- Exclude ignored content, dependencies, managed build output, and selected local environment files from winner transfer. Explicitly report exclusions so users understand what will not move.
- Support one user-configured test command per experiment, executed in each variant worktree. Run All Tests is sequential by default with cancel and timeout controls.
- Store exit code, start/end time, duration, and the code revision/content fingerprint associated with the run. Any subsequent source change marks the result Stale.
- A zero exit code means the configured command succeeded. Do not infer coverage, correctness, or a winner from it. No test command means Not configured, never Passed.

### FR-06 — Apply winner

- Treat application as a guarded transfer of baseline-to-winner changes into the original workspace, not a branch checkout, force reset, or automatic merge.
- Require the original repository to remain on its recorded branch and baseline commit, with no tracked changes, eligible untracked files, unsaved buffers, or active Git operations. If it moved, block with instructions to preserve/export the variant and start a new experiment; V1 does not resolve divergence.
- Freeze winner editing operationally: stop its owned commands and require saved buffers. Capture a stable content fingerprint and exact transfer artifact; if files change during preparation or application, stop rather than silently use a moving target.
- Present a review with file changes, exclusions, test freshness, and clear wording that the result will be uncommitted changes in the original workspace.
- Build and validate a transfer artifact in temporary storage, including supported binary content and additions/deletions. Unsupported symlinks, special files, or path conditions must block before modifying the original workspace.
- Validate path boundaries and reject paths escaping the repository or entering Git metadata. Apply only the reviewed artifact; do not copy the entire worktree.
- Record enough information to restore only the touched paths on failure when their contents still match BranchLab's partially applied output. If concurrent edits prevent safe rollback, preserve the artifact and show affected paths; never overwrite those edits automatically.
- Recheck relevant guards immediately before mutation. On success, show the resulting diff and Applied · Not committed. Do not stage, commit, push, or remove experiments automatically.

### FR-07 — Recovery and cleanup

- Persist session metadata and lifecycle changes atomically. Reconcile metadata with git worktree list --porcelain on startup.
- On VS Code reload, show retained variants and recovered statuses. Do not automatically rerun package scripts or restart servers.
- Track owned child processes with launch identity as well as PID; do not terminate an unrelated process after PID reuse. Normal shutdown terminates owned process trees; interrupted shutdown uses validated ownership or reports manual cleanup.
- Stop servers without deleting worktrees. Archive hides an experiment from active views but preserves its files.
- Deletion shows affected worktrees/branches and checks for work created beyond the baseline, including committed changes. Require explicit discard confirmation or preservation/export before removing user work.
- Use Git worktree removal and delete only branches created and still owned by the experiment. Never force-remove an arbitrary directory or prune unrelated worktrees.

## 7. Lifecycle and data model

Experiment states: creating, active, applying, applied, archived, error. Deletion is an explicit operation with its own progress journal. Variant setup/runtime states: created, installing, stopped, starting, running, error, missing.

Keep setup/runtime status separate from test status so a passing test does not imply a running preview. Track interrupted operations and their last completed step.

Records (minimum fields):

- Experiment: schemaVersion, ID, title, repository identity/path, original branch, baseline SHA, app root, adapter, package manager, variant IDs, timestamps, state
- Variant: ID, label, brief, owned branch, worktree path, setup state, server state, port/URL, command configuration, environment-file paths, last error
- Test run: ID, variant ID, command, content fingerprint, timestamps, exit code, status, local log reference
- Operation journal: operation ID, kind, affected owned resources, expected fingerprints, completed steps, recovery information

Store records in extension-managed local storage, not automatically in repository files. Never put environment-file contents, access tokens, or browser state in these records. Logs can contain application secrets; keep them local, bound their size, and make export explicit. Disable telemetry by default in V1 — BranchLab has no telemetry at all.

## 8. Proposed technical design

Implementation language: TypeScript. Use a Node extension host, VS Code commands/tree views/diff editors, and a bundled webview UI.

Modules:

- RepositoryService: Git discovery, guards, worktree operations, baseline comparison.
- ExperimentService: lifecycle, ownership, metadata, recovery journal.
- FrameworkAdapters: explicit Vite/Next.js launch and readiness behavior.
- ProcessSupervisor: dependency install, dev servers, test commands, cancellation, process-tree ownership.
- ComparisonController: validated messages, previews, routes, status and diff navigation.
- WinnerTransferService: snapshot, artifact validation, reviewed application, guarded recovery.

Run Git with argument arrays and explicit working directories; never interpolate titles, briefs, or paths into shell commands. Project scripts are executable project code and require a trusted workspace. Validate webview messages against a closed command schema; preview content must not gain extension-host command access. Restrict webview resource roots and use a Content Security Policy permitting only necessary local preview origins and bundled UI assets.

V1 must handle paths with spaces and Unicode. Ports and process cleanup require platform-specific verification. Multiple app instances can consume substantial memory, so show actionable startup errors and allow one running variant at a time without ending the experiment.

## 9. Acceptance scenarios

| ID | Scenario | Required outcome |
| --- | --- | --- |
| AC-01 | Create three variants from a supported clean fixture | All have the identical baseline SHA, distinct owned branches/paths, and the original workspace is unchanged. |
| AC-02 | Attempt creation with a dirty file or unsaved buffer | Creation is blocked before worktree mutation with a specific remedy. |
| AC-03 | Edit variant A | B and C files remain unchanged; A's diff updates and prior test result becomes stale. |
| AC-04 | Start servers while a candidate port is occupied | The unrelated process survives; BranchLab chooses another port or reports a bounded failure. |
| AC-05 | A server crashes | Its card shows failure and logs; other running variants remain usable. |
| AC-06 | App refuses embedding | Browser fallback works and the failure does not mark the experiment corrupt. |
| AC-07 | Run a failing test command | The correct variant displays the actual nonzero exit code and logs; no false pass appears. |
| AC-08 | Apply winner with add/delete/rename/binary fixtures | Eligible reviewed changes arrive accurately as uncommitted changes; excluded files do not transfer. |
| AC-09 | Original branch advances or becomes dirty | Application is blocked; no original files are overwritten. |
| AC-10 | Winner changes during transfer preparation | Application aborts or requests a fresh review; no mixed snapshot is applied. |
| AC-11 | Interrupt creation/application and reload | Recovery reports the actual resources and incomplete step without destructive guesses. |
| AC-12 | Delete a variant containing user work | Explicit preservation/discard handling is required; unrelated branches/worktrees survive. |
| AC-13 | Stop servers on Windows/macOS/Linux | Owned process trees stop; unrelated processes are untouched. |
| AC-14 | Invalid webview message or escaping file path | Host rejects it without executing commands or modifying files. |

## 10. Delivery plan and release gates

1. Feasibility spikes: verify Vite/Next.js preview embedding/fallback, worktrees with each supported package manager, Windows process-tree cleanup, and a lossless baseline-to-workspace transfer prototype. Do not build the polished comparison UI before these pass.
2. Safe experiment foundation: preflight, two/three worktrees, metadata, editing windows, partial-create recovery, owned cleanup.
3. Running comparison: adapters, setup flow, environment selection, ports, readiness, previews, logs and browser fallback.
4. Evaluation and choice: diffs, test runner, stale-result handling, reviewed winner transfer, guarded rollback.
5. Release hardening: cross-platform fixture suite, failure injection, accessibility checks, documentation, packaging, and pilot validation.

Release gates: every acceptance scenario passes; supported Vite and Next.js fixtures complete the entire flow on all three desktop platforms; no unresolved data-loss bug; unsupported environments fail clearly; a packaged VSIX works without development tooling in the extension source checkout. Publish a compatibility matrix with exact versions verified during release rather than claiming support for all framework versions.

## 11. Validation approach

Use unit tests for lifecycle transitions, metadata migration, ownership checks, message validation, and path guards. Use real temporary Git repositories for worktree and transfer integration tests, including committed and uncommitted variant changes. Use executable fixture applications for process supervision, port collisions, installation failure, and preview readiness. Use VS Code extension integration tests for commands and view coordination.

Inject failures between mutation steps and verify original content, recoverability, and bounded cleanup. Manually verify embedded previews, fallback, keyboard navigation, themes, and usable layouts. Test performance against a documented reference machine; do not present development-server startup or test duration as an app-performance benchmark.

## 12. Risks and mitigations

| Risk | Product response |
| --- | --- |
| Worktrees share external services | State the boundary during setup; use mocks or disposable development resources; database isolation is deferred. |
| Preview embedding varies | Run an early feasibility spike and ship a first-class browser fallback. |
| Dependency installation is slow or requires network | Separate setup from experiment creation, show progress, support cancellation, and avoid claiming offline installation. |
| Three apps exhaust machine resources | Independent start/stop controls and sequential install/test defaults. |
| Applying a winner loses work | Clean pinned baseline, reviewed frozen artifact, prevalidation, ownership/path guards, and failure recovery. |
| Coding agents edit the wrong folder | Open labeled variant windows and provide the exact worktree path with copied briefs; agent isolation is not guaranteed. |
| Variant results are mistaken for rigorous experiments | Show test freshness and configuration; defer performance scoring and synchronized-state claims. |

## 13. Future versions

After V1 reliability and pilot evidence: browser-driven shared scenarios with explicit selectors; isolated browser contexts and test data; saved experiment recipes; optional agent integrations; combine selected changes from multiple variants; supported database sandbox adapters; reproducible performance comparisons. These are future directions, not V1 promises.

## 14. Technical references

- Git worktree documentation: https://git-scm.com/docs/git-worktree
- VS Code Webview API, messaging, local resource restrictions, and CSP: https://code.visualstudio.com/api/extension-guides/webview
- VS Code extension capabilities: https://code.visualstudio.com/api/extension-capabilities/overview
- Vite server options, including host/port configuration: https://vite.dev/config/server-options

V1 completion definition: A developer can create two or three independent implementations, run and compare them, inspect current evidence, and transfer a chosen implementation to the original clean workspace without losing work or depending on a paid service.
