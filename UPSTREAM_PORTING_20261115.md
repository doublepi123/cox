# November 15 upstream follow-up

Cox audit baseline: `c8f8cd39d94a2acf3718f7264b99f9973ba6a899` (0.1.93).
Fixed upstream range:
`77d3358a1f6f49a6a0da05d815c52ddf0485caee..52451a7909cf5f20b3fe10309ff904d2472ac486`
(485 non-merge commits).

This is a selective adaptation between independently rooted repositories, not
an ancestry merge. Ten domain audits and an independent source-verification
pass classified all 485 commits in the range: 76 pure out-of-scope or absent
commits, 6 commits already equivalent in Cox, 205 commits excluded or deferred
for scope or architectural divergence, 157 certified lower-priority units
deferred for later batches, and 41 high-value upstream commits adapted below
across 41 surgical behavior units.

## Selected adaptations

| Upstream commits | Cox behavior                                                                                     |
| ---------------- | ------------------------------------------------------------------------------------------------ |
| `79e47e9096`     | Convert inline code paths like `docker/Dockerfile` into file chips.                              |
| `60e4be49cf`     | Open relative Codex citations whose filenames carry punctuation.                                 |
| `528c77fe83`     | Keep `.localdomain` hosts out of external favicon requests.                                      |
| `137a869138`     | Use HTTP for schemeless loopback preview URLs.                                                   |
| `2e0353daae`     | Compare prerelease semver identifiers without locale or precision loss.                          |
| `e0ca4fcecb`     | Retry failed terminal resize calls across client-runtime and the drawer.                         |
| `e6344bebd8`     | Normalize MCP app image content blocks so tool results deliver instead of hanging.               |
| `3a87ca8c6a`     | Preserve integer precision beyond `2^53` in tool output rendering.                               |
| `e72dd5055e`     | Release shared terminal grid state when terminal views close.                                    |
| `015eba4083`     | Allow retrying a failed MCP-over-ACP bridge disconnect.                                          |
| `1dfc746c8f`     | Exclude bypass-permissions options when approving a Devin ACP plan.                              |
| `5f29d87c9b`     | Prevent an ACP cancel from overtaking the prompt it cancels.                                     |
| `db0ae7b6e1`     | Ignore blank lines from ACP agent stdout instead of ending the session.                          |
| `93cd25a99b`     | Treat managed ACP registry binaries named like `..agent` as contained inside their install root. |
| `4c9a87309d`     | Keep the server running when the Cursor SDK aborts a stalled request (`onStall`).                |
| `52451a7909`     | Keep Claude monitor threads waiting between background updates.                                  |
| `9ec71438cd`     | Cap context-handoff work reserve so small context windows retain transfer budget.                |
| `6f06f2675d`     | Settle unfinished Codex web-search items when a turn ends.                                       |
| `9504f65989`     | Sanitize non-string JSON Schema enums on advertised MCP tools for Gemini compatibility.          |
| `240fc6975b`     | Surface early Codex app-server exit causes before `initialize` instead of `EPIPE`.               |
| `252b2c77b3`     | Propagate crashed Codex notification handlers and transport worker failures instead of hanging.  |
| `52074e9258`     | Stop leaving Codex plan items marked running after their run finishes.                           |
| `852f53b801`     | Include untracked files in working-tree status even when `status.showUntrackedFiles=no`.         |
| `d2a9414359`     | Refuse unresolved UTF-16 merge commits and support large UTF-16 diffs.                           |
| `52c62087b3`     | Keep a pushed commit successful when the post-push Git status read fails.                        |
| `2d80ca0852`     | Report rate-limited GitHub PR review-thread reads instead of silently hiding threads.            |
| `df15bd4f7b`     | Serialize parallel worktree branch renames under the shared repository config lock.              |
| `11c425b4b6`     | Report restart-continued child runs accurately in `task_status` instead of `cancelled`.          |
| `6a510c4894`     | Reject MCP OAuth resource indicators carrying an empty `#` fragment.                             |
| `6c0032d655`     | Reject disallowed browser `Origin` headers on `/mcp` with HTTP `403` before auth and CORS.       |
| `0bd581b078`     | Regenerate an empty persisted server secret atomically instead of failing startup.               |
| `033ae7cba0`     | Fail unreadable orchestration outbox effects cleanly without blocking subsequent thread work.    |
| `3209fa9534`     | Keep queued messages waiting when worktree setup has failed instead of bypassing setup.          |
| `85168744f7`     | Close open approval and question requests when stopping a stalled run.                           |
| `828200fc04`     | Enqueue terminal `clear` persistence without draining an ever-busy output stream.                |
| `7d4f242375`     | Cover abandoned turns from interrupted and cancelled runs during startup recovery.               |
| `0b4e83d7d0`     | Fork post-checkpoint display/Git status refreshes so the next turn starts without waiting.       |
| `9a79883979`     | Resolve tool-call diff file opens relative to nested project workspaces.                         |
| `a6d7695064`     | Preserve the mounted diff code view across collapse-all and expand-all toggles.                  |
| `2b7fc890de`     | Guard shared composer prompt/caret resets when a send finishes after route navigation.           |
| `b96a511067`     | Assign distinct stable keys to repeated file blocks in diffs so the viewer does not crash.       |

The 41 upstream commits above are adapted across 41 behavior units. Cox tool
names, OMO Native priority, permission defaults, and loopback/auth/origin
boundaries are preserved. No dependency, lockfile, SQLite schema migration,
desktop shell, mobile, marketing, SSH, or relay change is introduced.

## Equivalent and excluded work

- `1e38ebb71b`, `d8b80a1097`, `39fcae5267`, `0983ab3e73`, `0fbe8a2e44`, and
  `32a6a7f70b` are already satisfied at Cox HEAD (including Cox `a2ce67537c`'s
  stricter `source === "builtin"` discovery check for OMO's `<builtin:tool-search>`).
- Commits adding new npm dependencies, SQLite schema migrations, desktop-shell
  changes (`apps/desktop` releases independently via `desktop-v*` tags), or
  broad multi-environment / lifecycle rewrites are excluded or deferred.
- Mobile apps, marketing pages, SSH remote environments, PeerLinks,
  GuestShareService, PairingGrantStore, Tailscale management, device hubs,
  dictation, and Linux AppImage packaging remain outside the Cox scope.

## Verification

Every adapted behavior unit passed RED-to-GREEN unit, integration, or Chromium
browser regressions under deterministic clocks and disposable render harnesses.
Workspace typechecks, `oxlint-plugin-t3code` lint checks, formatting checks,
production builds, runtime/dev smoke suites, and clean-worktree full server,
package, client-runtime, and web unit/browser suites verified the combined
release. Manual QA on an isolated built server and headless browser confirmed
SPA framing headers, MCP browser-origin `403` rejection, authenticated session
login, and responsive desktop (`1280x800`) and mobile (`390x844`) layouts
without overflow.

Publication targets Cox 0.1.94 without a desktop shell version bump.
