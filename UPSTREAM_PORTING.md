# Upstream port status

Latest follow-up: Cox baseline `69e6586c85`, upstream
`25bf84ab07..8e6a732305` (21 reviewed commits). The 10 recommended Cox-applicable
updates are adapted; details and current validation are recorded in
[the November 8 follow-up](UPSTREAM_PORTING_20261108.md).

## Initial November 7 batch

Cox baseline: `402cfc6bcdbdd17ad00e438ceb9d74d571182b88` (2026-11-07).
Fixed upstream review range: `b18434e647..25bf84ab07f53f141c20239c63e383823a9d5ea0`
(263 commits). This is a selective local adaptation, not a merge of the
independently rooted repositories. Implementation and local acceptance are complete.

## Disposition

The [commit-by-commit inventory](UPSTREAM_PORTING_COMMITS.md) classifies all 263
commits: **168 adapted, 8 already equivalent, 87 intentionally excluded**. Adapted
means the Cox-applicable behavior, not every upstream file or permission default.
The keyed source-control secret support prerequisite (`84537c4dd9`, before this
range) was also adapted. No upstream checkout or live application data was changed.

The initial lint-cleanup request authorized source commits and a push to `main`.
That batch did not include a tag, publication, version bump or live deployment;
its completion versions were server `0.1.50` and desktop `0.2.11`. Later releases
and the November 8 follow-up are separate work.

## Delivered behavior

### Provider correctness and models

- Independent Claude Ultracode workflow toggle alongside effort; legacy Ultra /
  Ultracode selections migrate to the toggle without overriding explicit false.
  Keep Cox workflow activation, model-center protocol mapping and catalog isolation.
- Codex still adds Ultra automatically to every model advertising Max. Existing
  model-center Fast/service-tier handling remains intact.
- Claude turns and steering use the current downloaded catalog. Sonnet 5.5 and
  Haiku 5.5 workflow capabilities are exposed; settings compaction thresholds are
  reflected in provider context information.
- ACP interleaved terminal UTF-8, streamed child tools, typed native form answers,
  thread-id environment parity, strict final-line parsing and bounded raw
  notification retention. MCP bridge messages preserve U+2028/U+2029.
- Pi model switches retain explicit thinking, extension files are written atomically,
  and transient extension status is bounded, displayed and cleared on retirement.
- OpenCode empty replacements and interrupted tools, Muse recovery, Fx/Grok Unicode
  output, title-generation fallback and clearer provider failures.
- Incomplete ChatGPT registrations can be removed with confirmation and provider
  management permission. Existing signed-in/active registrations cannot be removed.
- Antigravity Intel-Mac installation, account-access refresh after installation,
  missing dependency guidance, Cox identity on qualified runtimes and old-version
  identity fallback. Other Cox-managed agent installation paths are preserved.
- Cursor account history and limits use the Cox/SDK account or explicit credentials,
  not stale Cursor CLI files or macOS Keychain fallback. API keys are hashed for
  cache identity; a failed new account cannot show a prior account's history.

### Orchestration, recovery and performance

- Atomic cross-thread command receipt checks, stopped-run checkpoint baselines,
  rewind-history import, usage-limit recovery across restart, and no recovery for
  children whose parent is archived/deleted/settled.
- Settlement waits for automatic follow-ups; usage-limit pauses show one recovery
  notice instead of repeating provider/lifecycle errors.
- Ordered provider snapshot batches use one transaction and publish after commit,
  preserving control-event ordering, per-snapshot savepoints, rollback and bounded
  queues. `COX_PROVIDER_COMMIT_BATCHING=false` disables batching.
- Bounded shutdown recovery batches, filtered restart preparation and combined
  runtime projection queries. Provider-thread ownership reads start from owned rows.
- Coalesce tool output before retention, share wire projection across subscribers,
  larger bounded WAL backpressure, idle browser disposal, separate background Git
  discovery, concurrent PR wakes, striped PR cache invalidation and cheaper Linux
  process probes.
- Shared socket/session recovery and bounded ACK windows; per-cwd catalog loading
  is opt-in and does not change the local-only connection model.

### Secrets and local security

- Real password inputs for private secret cards, one secret per card, optional
  configured secret-provider references, retry after unlock, cancellation and
  concurrent-answer guards. Values/references are not recorded in thread messages.
- Antigravity/OpenCode and per-host source-control credential references; unreadable
  referenced credentials fail closed instead of selecting an inherited account.
- Removing a secret provider clears its field/environment references, including Cox
  model-service settings, while retaining unrelated settings. Deletion requires
  both settings-write and provider-management scopes.
- MCP authentication spans end before tool execution and tool spans omit raw input.
  Bearer/DPoP schemes are case-insensitive without changing token case or validation.
- Chrome headless security pin `157.0.8103.38`, checked platform archive sizes/hashes.
  Fake-IP diagnostics explain blocked resources without weakening SSRF protection.
- Loopback/default-bind, password, secure-cookie, MCP audience and origin boundaries
  remain enforced. No pairing, remote link or cloud surface is restored.

### Sessions, projects, Git and interface

- Fresh provider sessions in the same thread, `/clear` arms the next send without
  deleting visible history, and scheduled tasks select new-thread, continuing or
  fresh-session mode. Existing bound tasks retain continuing behavior.
- Cox migration **080_ScheduledTaskThreadMode** follows the retained Cox migration
  **079_RemovePairingAuthentication**; upstream migration numbering is not copied.
- Project actions can opt into stop-on-settlement; ordinary commands/dev servers
  remain untouched unless explicitly selected. Scheduled tasks link to their thread.
- Git rollback cleans files hidden by a newly created `.gitignore` while preserving
  Cox's unborn-repository guard. English Git failures, Windows process spawning,
  local upstream-branch PR matching, home-relative/deleted project paths, IPv6,
  numeric bare config, search and terminal-control parsing are corrected.
- PR cache-first detail paint, scoped bounded IndexedDB query persistence and
  mutation replies update loaded readers without unnecessary host re-reads.
- GitHub media retains the PR repository and supports SSO upload retrieval; later
  activity pages omit PR-wide fields, and required-review status is not erased.
- GitLab author/bot identity, editable labels, source-branch deletion, edited-comment
  wakes, review findings, pipeline jobs, outdated discussions, request changes,
  fork maintainer edits, reviewer search and reference autolinks. Forgejo aliases
  and Azure DevOps branch/fork/default-branch fixes are included.
- PR composers complete users/issues/change requests; comments/conversations can
  be added to chat without replacing earlier context. Media tables and CRLF fences
  retain structure; review excerpt line endings are preserved.
- Sidebar drag/focus guards, collapsed-state persistence, latest reply age, directory
  caret/breadcrumb restoration, archive Delete, ACP project-generation guards,
  static task updates, selected-metric usage ranking and BOM theme publication.
- Optional tool visibility / Zen mode defaults to Show all; approvals, questions
  and errors remain visible. Cox IME/coarse-pointer focus behavior is retained.
- Cox desktop minimum and restored window bounds are 400x360. Modal/palette native
  titlebar clearance, short-window composer positioning and settings wrapping are
  adapted without replacing Cox's backend/update lifecycle.

## Intentional exclusions

- Native mobile apps, cloud accounts, device/simulator hosts, remote environment
  links, SSH/pairing, relay/tunnel infrastructure and upstream marketing/release CI.
- Native/paired/cloud dictation and unused transcription flows require a separate
  privacy/consent design; no new microphone or speech-provider consumer is added.
- Parent-side-chat permission inheritance, external-agent Auto defaults and changing
  the auto-settle default from three to seven days are not applied implicitly.
- Upstream service/SEA launcher, Electron browser and updater are not substitutes
  for Cox's isolated npm/backend staging, consent-based desktop updates and rollback.
- Cox already has installable 192/512 PNG icons and same-machine primary theme
  propagation. Do not replace working Cox brand assets or add remote-theme lookup.

## Initial port acceptance evidence

Tests used a disk-backed `TMPDIR`, isolated temporary state and
unset ambient `COX_MODEL_SERVICE_KEY` / `COX_CODEX_API_KEY`. No paid agent inference
was used. Detailed local logs are under
`${XDG_CACHE_HOME:-$HOME/.cache}/cox-upstream-port-20261107/`.

| Suite                                                     | Result                  | Evidence                                                                                   |
| --------------------------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------ |
| Server full suite                                         | 5,892 passed; 4 skipped | `server-full-final1.log`                                                                   |
| Web unit                                                  | 4,295 passed            | `web-unit-final1.log`                                                                      |
| Web browser                                               | 935 passed              | `web-browser-final1.log`                                                                   |
| Client runtime full suite                                 | 1,308 passed            | `client-full-final.log`                                                                    |
| Other packages / provider suites                          | 3,609 passed; 2 skipped | `packages-full-final.log`                                                                  |
| Desktop / distribution / root scripts                     | 264 passed; 1 skipped   | `root-full-final.log`                                                                      |
| Rust resource monitor                                     | 20 passed               | `rust-tests.log`                                                                           |
| Go protocol bridge                                        | Passed                  | `go-tests-final.log`                                                                       |
| Latest account-removal browser test                       | 1 passed                | `account-removal-browser-final.log`                                                        |
| Supplementary server regressions                          | 62 passed               | `final-server-regressions.log`                                                             |
| Compiler / timeline / permissions regressions             | 1,293 passed            | `final-web-regressions.log`                                                                |
| Small-window / picker / IME browser regressions           | 34 passed               | `short-window-browser.log`                                                                 |
| Workspace strict typechecks                               | Passed                  | `validation-after-comment-clean.log`                                                       |
| Production Web/server build                               | Passed                  | `build-complete.log`                                                                       |
| Desktop TypeScript build                                  | Passed                  | `desktop-build-final.log`                                                                  |
| Built server, local/password/external-bind authentication | Passed                  | `runtime-smoke-complete.log`, `password-smoke-final3.log`, `external-bind-smoke-final.log` |
| Actual development launcher / HTTP and WebSocket proxy    | Passed                  | `dev-smoke-final.log`                                                                      |

The full standard suites above total **16,303 passed and 7 skipped**; the additional
regressions overlap them and are not summed as new tests. The account-removal UI
test was added afterward and passed separately. No physical macOS/Windows runtime
or paid provider-protocol certification is claimed from Linux tests.

## Repository-wide lint cleanup

The initial changed-file baseline comparison is superseded by full-repository
cleanup: **1,245 errors and 70 warnings reduced to zero errors and zero warnings**.
No rule configuration was changed or disabled. Component-owned semantic variants
and real outer layout containers replace direct styling of restricted primitives.
Dead code was removed, test time and cleanup are deterministic, and live host
context updates and project-switch cancellation retain their effect semantics.

New browser regressions cover native control refs, keyboard menu activation,
disabled-item tooltips, focus restoration, command-input composition events,
combobox adornments and clearing, dialog widths, scrolling, loading placeholders,
stacked labels, compact switches, fixed selection actions and responsive media
navigation. A full timeline regression run exposed an incorrectly moved viewport
layout; it was corrected without changing the existing assertions.

Follow-up validation logs are under
`${XDG_CACHE_HOME:-$HOME/.cache}/cox-lint-cleanup-20261108/`.

| Follow-up suite                         | Result                   | Evidence                                                      |
| --------------------------------------- | ------------------------ | ------------------------------------------------------------- |
| Repository lint                         | Zero errors and warnings | `lint-final2.log`                                             |
| Repository formatting                   | Passed                   | `fmt-check2.log`                                              |
| Workspace strict typechecks             | Passed                   | `typecheck-final-workspace.log`                               |
| Server full suite                       | 5,901 passed; 4 skipped  | `test-server.log`                                             |
| Client runtime full suite               | 1,309 passed             | `test-client-final.log`                                       |
| Web unit and browser full suites        | 5,240 passed             | `test-web-final3.log`                                         |
| Other packages / provider suites        | 3,609 passed; 2 skipped  | `test-packages.log`                                           |
| Desktop / distribution / root scripts   | 264 passed; 1 skipped    | `test-root.log`                                               |
| Semantic control browser regressions    | 9 passed                 | `test-variants-final1.log`                                    |
| Timeline browser regressions            | 39 passed                | `test-ui-regressions2.log`                                    |
| Diff lazy-loading focused regressions   | 7 passed                 | `test-diff-recheck1.log`                                      |
| Production Web/server and desktop build | Passed                   | `build-final1.log`, `desktop-build-final1.log`                |
| Local/password/external-bind smoke      | Passed                   | `smoke-local.log`, `smoke-password.log`, `smoke-external.log` |
| Development launcher/proxy smoke        | Passed                   | `smoke-dev.log`                                               |
| Rust resource monitor                   | 20 passed                | `test-rust.log`                                               |
| Go protocol bridge                      | Passed                   | `test-go.log`                                                 |

The standard server, Web, client-runtime, package and root suites total
**16,323 passed and 7 skipped**, with Rust's 20 passing tests and the Go suite
reported separately. One intermediate three-worker Web run hit the diff-footer
lazy-loading timing assertion; its focused recheck passed all seven tests and
the final full two-worker run passed without changing that assertion.

### Remaining baseline benchmark, not hidden as green

- The optional `renders` benchmark is separate from the standard Web unit/browser
  script. `app-stream-assistant-turn` reports 59 MarkdownParagraph renders against
  an assertion of 30, **identically on baseline and current**. See
  `render-baseline-stream.log` and `render-current-stream.log`; its assertion was
  not weakened. An indiscriminate `vp test run` also includes render scenarios that
  require `T3CODE_RENDER_REPORT_DIR`; standard acceptance uses the package projects.
- Browser tests emit expected local discovery proxy failures when no development
  backend listens on port 4773, plus Node experimental API warnings. Isolated live
  server and development-launcher smoke tests passed separately.
