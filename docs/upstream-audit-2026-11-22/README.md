# T3 upstream review, 2026-11-22

The review covers the T3 range `d26066000d31146070a94a178e2cebe5513bb279..c7a9fba06bdb143bd380e610487a46c9e96f35cc`, 351 linear commits, against Cox base `751ac53a1db99a12bf471ba3e7817a7395879d2f`. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |   217 |
| Equivalent in Cox |    23 |
| Excluded          |   111 |

[Commit ledger](commits.tsv) lists the whole range in Git order with the Cox commit for each port and a specific reason for every equivalent or excluded commit. Exclusions name the Cox file or subsystem that is absent, together with the AGENTS.md scope rule or the matching decision in the [November 20 audit](../upstream-audit-2026-11-20/commits.tsv). The excluded areas are T3 Connect, relay and linked environments (20), issue trackers (13), speech and dictation (9), the upstream Expo mobile app (10), SSH, tunnels, WSL and the Linux desktop (7), the device hub (3), Antigravity runtime paths Cox does not use (6), upstream tooling, evals and release metadata (10), and 33 changes to other subsystems that Cox lacks or replaced.

The larger ports include multi-repository projects, which use additive migrations 082 and 083, as well as running Cursor SDK agents out of process and upgrading Effect from 4.0.5 to 4.1.5. Patches that conflicted with Cox's code were re-implemented against Cox's version, together with their upstream tests.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, the root tests, every package test suite, the full server suite and the web unit and browser suites, along with the runtime smoke test. The web suites passed twice in a row. Pre-existing and load-sensitive test failures found during integration were fixed instead of skipped. Native Windows, macOS and iOS behavior and authenticated provider sessions were not exercised on this Linux workstation.
