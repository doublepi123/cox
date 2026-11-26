# T3 upstream review, 2026-11-26

The review covers the T3 range `8b70e73371600fba98acea7e10709c07cc05fd9f..a0885a912318fba7270b39a5ccbb0588136268b8`, 487 linear commits, ported onto Cox 0.2.46. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |   366 |
| Equivalent in Cox |    12 |
| Excluded          |   109 |

[Commit ledger](commits.tsv) lists the range in Git order with the Cox commit for each port and the specific reason for each equivalent or excluded commit. Exclusions cover subsystems Cox does not ship: the upstream Expo mobile app and its native patches, T3 Connect, the relay and Clerk, linked environments and pairing, the managed SSH remote, the device hub, voice, managed policy, issue trackers, the Electron preview host and SnapShot, the T3 installer and service CLI, T3 telemetry backends, benchmark and metrics scripts, launch videos and upstream CI. WSL changes are left out by decision.

Workflows gain question kinds, run tags and subjects, named pools, richer answers and question withdrawal, and stay behind the Labs setting. Worktree layout commands now run only after a person approves the exact command text. Migrations 091 to 098 are additive. Vite Plus moves to 1.8.0.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, root tests, every package test suite with default timeouts, the full server suite with and without the Codex and Claude CLIs on PATH, the stock web unit and browser suites in two consecutive runs without retries, the desktop tests and the runtime smoke test. Failing and timing-dependent tests found during integration, including ones that already failed before this batch, were fixed at their cause. Native Windows, macOS and mobile behavior was not exercised on this Linux workstation.
