# T3 upstream review, 2026-11-23

The review covers the T3 range `c7a9fba06bdb143bd380e610487a46c9e96f35cc..7ddc81d639aa75ca6e0cbffb0f394ea3f0d83308`, 86 linear commits, ported onto Cox 0.2.30. Every commit is ported unless Cox has no use for the feature or the change contradicts a deliberate Cox modification.

| Disposition       | Count |
| ----------------- | ----: |
| Ported            |    72 |
| Equivalent in Cox |     3 |
| Excluded          |    11 |

[Commit ledger](commits.tsv) lists the range in Git order with the Cox commit for each port and the specific reason for each equivalent or excluded commit. The commits not ported are:

- `b9d0f70b3e` excluded: fix(mobile): replace undefined text-foreground-subtle token with text-foreground-muted
- `e3f9db2447` excluded: fix(server): TanStack Source pull requests open from every client, and private ones work end to end
- `7f125d83d1` equivalent: fix(server): Resume sends pending context to providers without native resume
- `379a98ac22` excluded: fix(server): t3 pair skips Windows VirtualBox and VMware host-only adapters
- `5fc2eb2f47` excluded: fix(mobile): the iOS composer keeps its keyboard and caret after dictation
- `671e05bc8c` excluded: fix(issues): an Activity cross-reference opens the issue or pull request it came from
- `c585a58598` excluded: fix(mobile): prevent clipped percentages in usage limit cards
- `4868aeb03d` equivalent: fix(mobile): pulling to Load earlier activity no longer snaps the feed back to the end
- `d834a4e117` excluded: fix(web): preserve reply-only edits when a queued message leaves the queue
- `9f19a6ddf5` excluded: fix(server): runtime prune removes the runtime a committed update replaced and abandoned staging
- `3d7bb17181` equivalent: fix(mobile): model search finds legacy models
- `31790d8d3e` excluded: fix(mobile): account badge on the provider icon is readable without an accent color
- `344de5fe8e` excluded: fix(antigravity): bound silent post-settle background command holds
- `5ddcc2598d` excluded: fix(desktop): WSL is not offered or started when only the Windows install stub exists

The chat Markdown renderer now uses upstream's Words static islands. Formulas still render through Cox's KaTeX component so chat and response images keep their math. Migrations 084 and 085 add indexes for worktree path lookups and deferred slash commands.

The integrated branch passes the frozen install, typecheck, lint, format check, production build, root tests, every package test suite, the full server suite, the web unit and browser suites, and the runtime smoke test. Windows-only command discovery cases and native mobile behavior were not exercised on this Linux workstation.
