# November 8 upstream follow-up

Cox baseline: `69e6586c85` (server `0.1.53`, desktop `0.2.14`).
Fixed upstream range: `25bf84ab07..8e6a7323050ea8d2891f745f7e624e84f9fd8d9a`.
The user authorized the 10 previously recommended changes, not all 21 commits.
The [inventory](UPSTREAM_PORTING_COMMITS.md#november-8-follow-up) records all 21
dispositions. This is selective behavior adaptation, not a repository merge.

## Delivered changes

1. Muse `/compact` admission failures and no-op responses settle with their reason
   without losing a held background wake or acknowledging Stop on live child work.
2. HTML preview/render accept exactly one of inline `html` or an absolute `path`.
   Path reads require a full-access caller and a regular, singly linked `.html` or
   `.htm` document starting with an HTML document marker, bounded to 25 MiB.
   Network paths, internal secret/database paths, invalid symlink targets,
   directories and oversized sources are refused. Publication stores a snapshot;
   provider recovery matches repeated path calls in publication order.
3. Preview screenshot saving keeps the original image while the model still sees
   a capped image. Original base64 is not included in public snapshot metadata.
4. Scheduled tasks can move to another thread in the selected local project.
   Search includes older matching thread shells and excludes archived threads,
   subagents, side chats and other environments/projects. Destination changes are
   validated before saving or consuming a webhook secret; unchanged archived
   bindings remain editable. New-thread, continuing and fresh-session modes,
   run history and the next scheduled time retain their existing semantics.
5. Antigravity custom `agy`/`antigravity` CLI paths run the `acp` subcommand without
   a harness sibling, keeping launcher symlink names and PATH fallback behavior.
   The Cox-managed runtime still requires and validates its official harness.
6. Handoff history skips oversized messages before serializing their envelopes;
   selected messages and UTF-8/JSON byte-budget guarantees remain intact.
7. Storage reports include registered worktrees nested under ordinary folders,
   without recursively walking arbitrary large trees or treating stale
   registrations and project-owned checkouts as removable orphan worktrees.
8. Whole-word thread title matches rank above popular prefix matches, retaining
   explicit picks and existing short-query/filler-word behavior.
9. Rendered Markdown strong content uses weight 700.
10. Long lineage phase headings truncate inside their details card rather than
    pushing its accessory/count/disclosure controls out of bounds.

All new UI text is in both English and Chinese. Restricted primitive styling uses
existing semantic props; lint rules, permission defaults, model-center routing,
Codex Ultra and Claude Ultracode behavior are not relaxed or replaced.
Servers without the thread-mode capability still allow a thread-to-thread move;
the unsupported new-thread unbind option is hidden rather than saving a no-op.

## Validation

Local evidence is under
`${XDG_CACHE_HOME:-$HOME/.cache}/cox-upstream-followup-20261108/`.
All tests use isolated temporary data and a disk-backed `TMPDIR`; ambient model
service credentials are unset. No paid inference is used.

| Check                                                                      | Result                   | Evidence                                                        |
| -------------------------------------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Repository lint                                                            | Zero errors and warnings | `lint-final-current.json`                                       |
| Repository formatting                                                      | Passed                   | `fmt-final-current.log`                                         |
| Workspace strict typechecks                                                | Passed                   | `typecheck-final-current.log`, `typecheck-web-final.log`        |
| Server full suite with the real sandboxed browser                          | 5,916 passed; 1 skipped  | `test-server-verified.log`                                      |
| Web unit/browser full suite                                                | 5,273 passed             | `test-web-final-serial.log`                                     |
| Client runtime full suite                                                  | 1,309 passed             | `test-client-runtime1.log`                                      |
| Provider/shared/contract package suites                                    | 3,615 passed; 2 skipped  | `test-packages-full1.log`                                       |
| Desktop/distribution/root suites                                           | 276 passed; 1 skipped    | `test-root-final.log`                                           |
| Scheduled task phone/desktop browser regressions                           | 8 passed                 | `test-scheduled-browser3.log`                                   |
| Related and previously flaky browser regressions                           | 33 passed                | `test-browser-recheck.log`                                      |
| Real HTML preview, disk/network guards and toolkit validation              | 43 passed                | `test-security-preview4.log`                                    |
| Production Web/server and desktop builds                                   | Passed                   | `build-final.log`, `build-desktop-final.log`                    |
| Built local/password/external-bind authentication and HTTP/WS origin smoke | Passed                   | `smoke-final.log`, `smoke-password1.log`, `smoke-external1.log` |
| Development launcher and proxy smoke                                       | Passed                   | `smoke-dev1.log`                                                |

The initial and final complete Web unit/browser runs both passed 5,273 tests in
469 files (`test-web-full1.log`, `test-web-final-serial.log`). Intermediate
parallel reruns hit diff lazy-loading and follow-up-menu timing assertions in
unchanged source; their targeted recheck passed all 33 tests and the final full
single-worker run passed. No assertion, timeout or exclusion was weakened.

The final server, Web, client-runtime, package and root suites total
**16,389 passed and 4 skipped**. The root count includes 12 tests from a separate
concurrent desktop-menu task, not new upstream-port coverage. Its commit
`633b7d54bb` touches only the five desktop-menu files, which this follow-up did
not edit; current workspace typechecks, lint and the desktop build passed after
that concurrent change. Full physical Windows/macOS runtime certification is not
claimed from these Linux checks.

The first real-browser attempt used Playwright's generic cache path, which the
host AppArmor profile does not authorize. The browser was copied into the
isolated matching path and then passed the tests with its sandbox enabled. Early
new invalid-source assertions were corrected to distinguish the existing plain
text preview errors from JSON render-tool failures; production error handling
was not relaxed to fit tests.

## Operational boundaries

The subsequent `push` request authorizes committing this follow-up and pushing
it to `main`. No tag, release, dependency upgrade, version bump or deployment is
part of this request. The separate desktop `0.2.15` version-only commit
`d68ecdbec0` already precedes this source commit. No live Cox data or original
T3 checkout was modified.
The test browser is copied into an isolated cache path matching the existing
AppArmor rule; no system profile or browser-sandbox policy is changed. The optional
render-count benchmark remains separate from standard Web acceptance, as recorded
in the initial port report.
