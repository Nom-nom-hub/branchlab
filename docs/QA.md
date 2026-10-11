# BranchLab QA — acceptance scenario status (v0.1.0)

Automated evidence from `npm test` (unit + real-Git integration +
process supervision against live fixture servers). Items marked
*host check* need a real VS Code window — they cannot be proven from
the test harness and must be verified by a human before release.

| ID | Scenario | Status |
| --- | --- | --- |
| AC-01 | Three variants, identical baseline SHA, original unchanged | Automated — experiments + git integration tests |
| AC-02 | Dirty file / untracked / detached HEAD block creation | Automated — preflight tests (unsaved buffers are a host check) |
| AC-03 | Variant isolation; diff updates; test goes stale | Automated — worktree isolation + fingerprint staleness tests |
| AC-04 | Occupied port: unrelated process survives, next port chosen | Automated — supervisor test with a squatter server |
| AC-05 | Server crash surfaces with logs; others unaffected | Automated (exit surfaces in state/log) + host check for card |
| AC-06 | Embedding refused → browser fallback | Host check — card + Open in Browser are always present by design |
| AC-07 | Failing test command shows real exit code, no false pass | Automated — supervisor exit-code test + status derivation tests |
| AC-08 | Winner transfer: add/delete/rename/binary, env excluded, uncommitted | Automated — full transfer round-trip test |
| AC-09 | Original advanced/dirty → apply blocked | Automated — validateOriginal tests |
| AC-10 | Winner moves mid-transfer → abort | Automated — fingerprint mismatch test |
| AC-11 | Interrupted create + reload recovery | Automated (journal + reconcile) + host check for the warning |
| AC-12 | Delete with user work requires discard confirmation | Automated — delete lifecycle test |
| AC-13 | Stop servers; unrelated processes untouched | Automated on Linux; Windows taskkill path is a host check on Windows |
| AC-14 | Invalid webview message / escaping path rejected | Automated — message schema + path guard tests |

## Manual checklist before a public release

- [ ] Windows: full flow on a real Vite app (create → install → start →
      preview → apply), incl. process-tree stop with child processes
- [ ] macOS: same flow on a real Next.js app
- [ ] A Vite app that sets X-Frame-Options: preview blocked, card intact,
      Open in Browser works
- [ ] Panel keyboard navigation + focus visibility in dark and light themes
- [ ] Creation time on the reference machine recorded (PRD §3 measure)
