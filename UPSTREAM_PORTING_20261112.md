# November 12 upstream follow-up

Cox audit baseline: `dc39364c6913eed952a8036726ecf970040aba2e` (0.1.75).
The shared checkout advanced to `692d95db4762eaeaa88ab59c18740da13157f250`
(0.1.76) during the audit; that increment changed only release versions.
Fixed upstream range:
`0f13d2ccbd76ee1fc314b8c54f575f9691f78b51..fc2b5de20cb572d2333e03284466e3c804d25c84`
(646 commits).

This is a selective adaptation between independently rooted repositories, not
an ancestry merge. The audit inventoried every commit subject. Four domain
inventories cover 566 unique commits; 80 remaining commits were not inspected
at code level. Selected changes were checked against both upstream diffs and
Cox implementations. Inventory coverage does not imply every diff was read.

## Selected adaptations

| Upstream commits                                                     | Cox behavior                                                                                                                                                      |
| -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `26f0a62f73`, `68a564ef69`                                           | Grant ACP terminal execution only after an execute approval; deliver follow-ups while the agent finishes background work.                                         |
| `8df455c09b`                                                         | Resolve and validate registry executable containment before changing its mode.                                                                                    |
| `80cccdcef3`, `429c0ac2d3`, `06274896ee`, `a33d50a539`, `8ef649f8b5` | Isolate Git repository selectors, terminate timed-out children, preserve sequencer state, stream large selected pathspecs and refuse unresolved conflict markers. |
| `3a815e9749`                                                         | Keep relative Markdown media on the owning server rather than falling back to a local file.                                                                       |
| `962eeefa03`, `ced85c64ff`, `de21fbcff3`                             | Preserve message command identity on reconnect, bound unanswered sends and recover failed thread subscriptions.                                                   |
| `cb931fcbe2`                                                         | Merge composer draft changes across tabs, including deletions.                                                                                                    |
| `25123c28d4`, `ddd02848e6`, `860fa7c7b6`                             | Recognize OpenCode and Grok HTML results, retain attachment ownership and inject HTML bootstrap after complete quoted attributes.                                 |
| `cbc38a1b0f`, `37e0fd378a`, `2de337003d`, `c085a0aa5d`               | Release effect-worker slots, settle recovery-read failures, interrupt provider turns that lose a Stop race and bound baseline capture.                            |
| `bfec2754b8`, `e2f1a21262`                                           | Recover delegated children under their own thread and retain their assistant report when a later error occurs.                                                    |
| `5c0eb5124e`                                                         | Persist missed or rejected scheduled runs as failures.                                                                                                            |
| `ac781dcb77`                                                         | Return the delegated-task handle before the default HTTP response deadline.                                                                                       |

The 24 upstream commits above are grouped into 17 behavior units. Cox tool names,
checkpoint names, permission defaults and local-server boundaries are preserved.
No upstream schema migration or mobile application is introduced.

## Equivalent and excluded work

- `1d61dd3fd6`: Cox already checks outstanding scheduled work transactionally,
  including queued, preparing, starting, running and waiting runs.
- The settings half of `cb931fcbe2` is already covered by Cox's locked patch
  merge. This adaptation addresses composer drafts only.
- `d353fba97e`: the desktop download timeout improvement requires an independent
  client release. Cox already has an abort deadline; the shell patch is not part
  of this backend release.
- Broad delegation rewrites, provider retry watchdogs and long-thread performance
  changes require separate integration or benchmark evidence and are not included.
- Mobile-only changes, managed remote environments, SSH, T3 Connect, relays,
  Tailscale management, Linux/AppImage clients and upstream release bots are outside
  the Cox scope or have no corresponding surface.

## Verification

The selected adaptations passed their focused regressions and production service,
filesystem, Git, SQLite and HTTP/WebSocket fixtures. Lead checks passed workspace
typechecking, lint, production builds and isolated runtime/development smoke tests.
Manual browser checks covered cross-tab draft preservation/deletion, message
acknowledgment recovery, thread resubscription, media routing and HTML bootstrap DOM.
Desktop and phone captures showed no overflow in the restored composer.

Retained suites: root 401 passed (1 existing skip), shared/provider packages 3,943
passed (5 existing skips), server 6,435 passed (5 existing skips), client runtime
1,360 passed. Web reported 5,521 passed and one timeout in the unchanged deferred
DiffPanel footer test; all six tests in that browser file passed on isolated rerun.
The failed full run is retained rather than described as wholly green.

Repository formatting initially reported both owned test hunks and concurrent
unrelated site/DESIGN changes. Owned files were formatted and rechecked; unrelated
work was preserved. The host's default Go installation lacks a LICENSE file;
builds passed with `GOTOOLCHAIN=go1.27.3 COX_GO_BINARY=/usr/local/go/bin/go`.

Publication targets Cox 0.1.77 without a desktop shell bump. The audit and release
ledger is `/tmp/ulw-20261112-183400.NcqIq8.md`.
