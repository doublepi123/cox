# T3 upstream review, 2026-11-22

The review continues from the previous T3 snapshot. The range is `d26066000d31146070a94a178e2cebe5513bb279..c7a9fba06bdb143bd380e610487a46c9e96f35cc` and contains 351 linear commits. Cox base is `751ac53a1db99a12bf471ba3e7817a7395879d2f`.

| Disposition | Count |
| --- | ---: |
| Ported | 18 |
| Equivalent in Cox | 3 |
| Excluded | 40 |
| Candidate, not yet ported | 81 |
| Deferred after initial review | 209 |

[Commit ledger](commits.tsv) lists the complete range in Git order together with the selected Cox commits. Candidate and deferred rows retain the review status for the next batch. The deferred rows include initial path-based screening where the full Cox integration has not been checked.

Verification covered the selected regressions, Chromium settings and project controls, Cox server replay, workspace typecheck, production build, and an isolated runtime smoke test. The live settings check opened the production scheduled tasks page at 1440px and 390px.
