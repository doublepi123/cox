# T3 upstream review, 2026-11-24

The review covers the T3 range `7ddc81d639aa75ca6e0cbffb0f394ea3f0d83308..ac3af66f2110cc53734d8d6a8f37744b50b24a80`, 362 linear commits, ported onto Cox 0.2.34. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |   256 |
| Equivalent in Cox |    22 |
| Excluded          |    84 |

[Commit ledger](commits.tsv) lists the range in Git order with the Cox commit for each port and the specific reason for each equivalent or excluded commit. Exclusions cover subsystems Cox does not ship: the upstream Expo mobile app, linked environments, pairing and guest links, the managed SSH remote, the device hub, speech, managed policy, Linear and issue trackers, the Electron preview host and SnapShot, the AppImage, the T3 installer and service CLI, server metrics scripts, upstream CI, and T3 trademark documents. WSL changes are left out by decision.

Durable workflows are ported behind a Labs setting that is off by default. Agent feedback reports are stored locally after scrubbing and are never uploaded. Outside agents can poll and stream milestones as MCP events or receive them by signed webhooks. Migrations 086 to 090 add workflows, run status, message search, agent feedback and superseded attempt indexes.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, root tests, every package test suite, the full server suite, the web unit and browser suites in two consecutive runs, the desktop tests and the runtime smoke test. Failing and timing-sensitive tests found during integration, including ones that already failed before this batch, were fixed instead of skipped. Native macOS, Windows and mobile behavior was not exercised on this Linux workstation.
