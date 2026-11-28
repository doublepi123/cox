# T3 upstream review, 2026-11-27

The review covers the T3 range `a0885a912318fba7270b39a5ccbb0588136268b8..4bc38b1c5e0244664f0bfe52b4929b7f446ac917`, 409 linear commits, ported onto Cox 0.2.48. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |   336 |
| Equivalent in Cox |    22 |
| Excluded          |    51 |

[Commit ledger](commits.tsv) lists the range in Git order with the Cox commit for each port and the specific reason for each equivalent or excluded commit. Exclusions cover subsystems Cox does not ship: the upstream Expo mobile app, linked environments and guest links, the device hub, voice, issue trackers including Jira, the Electron preview host, the T3 service launcher and WSL-only changes.

Files can unlock password-protected previews and be downloaded from the Files panel and chat file links, chat tables copy as PNG, EPUB previews gain captions, side-panel tabs can be selected together, and sidebar folders show six threads with Show more. Migration 099 adds an index for status-filtered turn-item reads.

The packaged desktop smoke tests run against a temporary inspector-enabled copy, and the release checks assert that the shipped app keeps the Node inspector fuse disabled.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, root tests, every package test suite, the full server suite with and without the Codex and Claude CLIs on PATH, the stock web unit and browser suites in two consecutive runs without retries, the desktop tests and the runtime smoke test, and a non-publishing desktop release build on macOS ARM, macOS Intel and Windows. Native Windows, macOS and mobile behavior beyond those CI builds was not exercised on this Linux workstation.
