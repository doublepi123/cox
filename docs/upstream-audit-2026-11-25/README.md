# T3 upstream review, 2026-11-25

The review covers the T3 range `ac3af66f2110cc53734d8d6a8f37744b50b24a80..8b70e73371600fba98acea7e10709c07cc05fd9f`, 122 linear commits, ported onto Cox 0.2.36. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |    86 |
| Equivalent in Cox |     4 |
| Excluded          |    32 |

[Commit ledger](commits.tsv) lists the range in Git order with the Cox commit for each port and the specific reason for each equivalent or excluded commit. Exclusions cover subsystems Cox does not ship: the upstream Expo mobile app, linked environments and pairing, the managed SSH remote, the device hub, voice, issue panels and TanStack Source, the Electron preview host, preview tunnels and SnapShot, the T3 installer and service CLI, the sidebar update capsule, upstream CI workflows and security docs. WSL changes are left out by decision.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, root tests, every package test suite, the full server suite with and without the Codex and Claude CLIs on PATH, the web unit and browser suites in two consecutive runs, the desktop tests and the runtime smoke test. Timing-dependent tests found during integration were fixed instead of skipped. Native Windows, macOS and mobile behavior was not exercised on this Linux workstation.
