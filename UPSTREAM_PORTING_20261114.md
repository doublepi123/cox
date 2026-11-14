# November 14 upstream follow-up

Cox audit baseline: `b2ae451ce762ef21a04be7b0d354750c37f5bd6c` (0.1.91).
Fixed upstream range:
`fc2b5de20cb572d2333e03284466e3c804d25c84..77d3358a1f6f49a6a0da05d815c52ddf0485caee`
(658 non-merge commits).

This is a selective adaptation between independently rooted repositories, not
an ancestry merge. Eleven domain audits classified all 658 commits in the
range: 54 pure out-of-scope commits (mobile, SSH, marketing, upstream CI),
5 commits already equivalent in Cox, 569 commits excluded or deferred for
scope, divergence, or batch boundaries, and 30 upstream commits adapted below
across 28 surgical behavior units.

## Selected adaptations

| Upstream commits           | Cox behavior                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `f4e65cd843`               | Treat a null model-selection `options` value as omitted during decode.                                                      |
| `f161a4d2b5`               | Percent-encode literal ampersands in citation Markdown destinations.                                                        |
| `f315da3339`               | Keep PASS and FAIL terminal badges readable in dark command output.                                                         |
| `0200dcf242`               | Route queued SQLite reads to the first reader connection that frees up.                                                     |
| `92c91aac8f`               | Keep inherited `Object.prototype` qualifier values as pull-request search text.                                             |
| `306914f016`               | Name whole-repository project groups from repository identity instead of a subfolder title.                                 |
| `1f55acf13b`               | Refresh older-settled thread counts when threads move between projects.                                                     |
| `77d3358a1f`               | Enumerate `/proc` by name so ACP teardown survives processes exiting mid-scan.                                              |
| `5fa95d99af`               | Wait for a newline-complete listening line before reading the OpenCode server address.                                      |
| `35483c198a`               | Surface `usage_limit` warnings while OpenCode 2 schedules quota or rate-limit retries.                                      |
| `d3ef7e8e52`               | Populate unset Cursor catalog default model parameters across chat, follow-ups, and text generation.                        |
| `f5ae8088c3`               | Stream Pi shell output as UTF-8-safe `command_output.delta` chunks instead of per-update snapshots.                         |
| `ae49f4d2a7`               | Honor explicit thinking options on custom Claude models absent from the built-in catalog.                                   |
| `0e250fa6f6`               | Preserve conflicted multi-commit sequencer state and reftable pseudo-refs during selected-file commits.                     |
| `cb6670b01d`               | Retry failed scratch Git probes instead of caching a transient timeout until server restart.                                |
| `9e180e5569`               | Preserve an existing UTF-8 BOM when saving files from the workspace editor.                                                 |
| `a4a8c61918`, `ed05c0e43b` | Re-resolve detached preview scroll targets within the action deadline and emit mousemove steps during preview drags.        |
| `6aa14d3cd5`               | Match accented messages on short search prefixes before SQL hit limits apply.                                               |
| `121f0cf014`               | Clamp oversized positive `cox_thread_list` limits to 100 instead of failing validation.                                     |
| `5ba3a84db4`               | Retry SQLite lock-timeout failures while settling claimed orchestration effects so threads do not stay stuck in `starting`. |
| `e80468ba25`               | Record only `eventType` on provider-event normalization errors without re-validating rejected payloads.                     |
| `94aa3d7736`               | Send `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY` on SPA HTML responses.                   |
| `c846833a6b`               | Allow creating provider instances named `constructor`, `toString`, or `valueOf`.                                            |
| `a678948483`               | Ignore pending-question digit shortcuts when focus is inside dialogs, menus, comboboxes, popups, or `<select>` controls.    |
| `000d82dc67`               | Consume `Escape` inside the theme editor and inspection mode without closing Settings.                                      |
| `953ce60d12`               | Preserve leading and trailing filename whitespace across checkpoint schemas and the diff panel.                             |
| `4574c6013d`, `0fdc99c870` | Preserve saved notebook traceback frame boundaries and strip ANSI escape sequences in previews.                             |
| `666631e94e`               | Pad copied inline-code Markdown when meaningful text begins and ends with spaces.                                           |

The 30 upstream commits above are grouped into 28 behavior units. Cox tool names,
checkpoint names, OMO Native priority, permission defaults, and loopback/auth/origin
boundaries are preserved. No dependency, lockfile, SQLite schema migration,
desktop shell, mobile, marketing, SSH, or relay change is introduced.

## Equivalent and excluded work

- `f8dc37d0b7`, `e4688f7cb9`, `95f164d083`, `5f85768394`, and `6f108e8556` are
  already satisfied by Cox's current preview resize handling, nested worktree search,
  editor test harness, and generated Codex app-server schemas.
- Commits adding new npm dependencies (such as `1159aa2991`), schema migrations,
  desktop-shell-only changes (`apps/desktop` releases independently via `desktop-v*`
  tags), or broad multi-environment / lifecycle rewrites are excluded or deferred.
- Mobile apps, marketing pages, SSH remote environments, machine mentions across
  hosts, T3 Connect, relays, Tailscale management, dictation, and Linux AppImage
  packaging remain outside the Cox scope.

## Verification

Every adapted behavior unit passed RED-to-GREEN unit, integration, or Chromium
browser regressions under deterministic clocks and disposable render harnesses.
Workspace typechecks, `oxlint-plugin-t3code` lint checks, formatting checks,
production builds, runtime/dev smoke suites, and clean-worktree full server,
package, client-runtime, and web unit/browser suites verified the combined release.
Manual QA on an isolated built server and headless browser confirmed `SPA_FRAME_HEADERS`,
origin-enforced session login, live theme-editor `Escape` containment, and responsive
desktop (`1280x800`) and mobile (`390x844`) layouts without overflow.

Publication targets Cox 0.1.92 without a desktop shell version bump.
