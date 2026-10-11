# BranchLab

**Try alternatives. Compare working results. Keep the best.**

BranchLab is a local VS Code extension for developing and comparing
alternative implementations of a feature. It creates two or three
isolated Git worktrees from the same commit, runs their dev servers,
shows their previews side by side, and transfers the winning variant's
changes into your original workspace as uncommitted changes — reviewed,
guarded, and never committed for you.

No account. No backend. No paid AI API. Bring your own editor or coding
assistant; BranchLab runs the experiment.

## How it works

1. **New Experiment** — preflight proves the repo is clean, committed,
   on a branch, and a supported app (Vite or Next.js; npm, pnpm, or
   Yarn). Name 2–3 variants and give each an optional brief.
2. **Worktrees** — each variant gets its own worktree and branch
   (`branchlab/<experiment>/<variant>`) at the exact pinned baseline
   commit, outside your source tree. Dependencies install per variant
   (lockfile-enforced) only when you click Install.
3. **Compare** — Start serves each variant on its own allocated loopback
   port with a real HTTP readiness check. The panel shows previews at a
   shared route and viewport, plus live change counts, per-variant logs,
   and diffs against the baseline in VS Code's diff editor.
4. **Test** — one configured test command per experiment runs per
   variant. Results are stamped with a content fingerprint: touch the
   code and the result reads **Stale** until rerun. No command means
   *Not configured* — never a fake pass.
5. **Apply Winner** — review the exact eligible changes (env files and
   exclusions named), confirm, and the changes arrive in your original
   workspace as uncommitted changes. Guards re-check the branch, the
   baseline, and a clean tree immediately before anything moves; if the
   winner changed mid-transfer, the application aborts.

**Isolation honesty:** worktrees isolate tracked files, installs, build
output, and dev servers. Git objects are shared, and databases, APIs,
and other external services are NOT isolated — use a mock or disposable
dev environment for variants that write to shared state.

## Commands

- `BranchLab: New Experiment`
- `BranchLab: Open Comparison Panel`
- `BranchLab: Refresh`

Settings: `branchlab.portRangeStart` / `branchlab.portRangeEnd`
(default 4300–4399).

## Privacy

Everything is local. Session records live in the extension's own
storage, never in your repository. Environment-file *contents* are
never recorded — only the paths you chose to copy. Logs stay local and
size-bounded. No telemetry.

## Development

```sh
npm install
npm run compile
npm test        # unit + real-git integration tests
npm run package # VSIX
```

The full V1 specification lives in [docs/PRD.md](docs/PRD.md).
