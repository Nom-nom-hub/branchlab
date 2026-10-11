# Changelog

## 0.1.4 — 2026-10-11

- **Delete no longer crashes on locked Windows files.** When Git had
  deregistered a worktree but its folder remained (installed
  node_modules), the filesystem fallback removed it with a bare
  rmSync — no retries, no guard — so a file still held by the
  just-stopped server or an open variant window threw EPERM straight
  through the command as a VS Code "system error". Removal now goes
  through a retrying remover (backoff while handles release, plus a
  settle beat after each server stop); if a folder still cannot be
  deleted, the delete completes and the folder is named in a plain
  warning instead. The delete command also catches its own failures —
  raw OS errors never surface as system errors again. The same
  hardening covers partial-create cleanup.


## 0.1.3 — 2026-10-11

- **Preview transport fix.** The comparison panel now routes its
  loopback preview requests through VS Code's webview port mapping
  (each allocated variant port is mapped as servers start), instead of
  relying on a bare cross-context iframe navigation — the shape
  Chromium's Local Network Access checks block
  (ERR_BLOCKED_BY_LOCAL_NETWORK_ACCESS_CHECKS). The Next.js dev server
  was verified innocent: on 14.2.35 it serves CSS/JS with 200 under
  every Origin header.
- Dropped the iframe sandbox attribute (with scripts + same-origin
  allowed it restrained nothing; one less variable in the embed path).


## 0.1.2 — 2026-10-11

- Preflight tells the truth about discovery failures: Git missing from
  PATH gets its own message (install Git, restart VS Code), and any
  other refusal (e.g. dubious-ownership) now quotes Git's own first
  error line instead of a generic "not a repository".


## 0.1.1 — 2026-10-11

- tsconfig now declares `"types": ["node"]` explicitly, so a fresh
  clone's TypeScript server resolves Node typings deterministically
  after `npm install` (without node_modules, `node:fs` imports and
  timers error exactly as a first-open suggests).


## 0.1.0 — 2026-10-11

First build, implementing the V1 PRD (docs/PRD.md) end to end:

- **Preflight + creation (FR-01)** — trust, clean committed baseline,
  branch/detached/merge/submodule/sparse guards, unsaved-buffer check,
  one active experiment per repo; creation journaled before mutation
  with journal-scoped partial cleanup
- **Worktree isolation (FR-02)** — two or three worktrees at one pinned
  SHA under `branchlab/<experiment>/<variant>` branches, stored outside
  the source tree; debounced change detection
- **Setup + execution (FR-03)** — lockfile-based package-manager
  detection, explicit Vite/Next adapters (real port/host flags, strict
  binding), lockfile-enforced installs on click only, opt-in env-file
  copies (paths recorded, contents never), allocated loopback ports
  with bounded rebind retries, owned process trees, bounded HTTP
  readiness with a Reachable · App error state
- **Comparison panel (FR-04)** — Activity Bar tree + card webview:
  setup/server/test chips, changed-file counts, shared route + viewport
  presets, sandboxed previews with a permanent Open in Browser fallback
- **Diff + tests (FR-05)** — full baseline→working-tree change sets in
  VS Code's diff editor against Git-object baselines; per-variant test
  runs stamped with content fingerprints that go Stale on any edit
- **Apply winner (FR-06)** — frozen, reviewed transfer artifact (binary
  patch + explicit untracked copies), env exclusions reported,
  branch/baseline/clean guards rechecked at mutation time, winner-
  movement abort, verification of every applied path; result is always
  uncommitted changes
- **Recovery (FR-07)** — atomic session store, startup reconciliation
  against `git worktree list`, servers never auto-restart, deletion
  blocked by un-preserved variant work until explicit discard

22 automated tests: unit (lifecycle, message schema, path guards,
ports), real-Git integration (preflight, worktrees, transfer round
trip), process supervision against live fixture servers, and a host
activation smoke test. See docs/QA.md for the AC-by-AC evidence map —
Windows/macOS host checks remain before a public release.
