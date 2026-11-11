# November 11 upstream follow-up

Cox baseline: `dc62840e6a432606512360fc503681897b1ba544` (0.1.64).
Fixed upstream range: `dc7270581800518b9d7d4db6c8e13852067c8c2d..0f13d2ccbd76ee1fc314b8c54f575f9691f78b51`
(165 commits). This release selectively adapts 38 applicable commits.

| Upstream commits                                       | Cox behavior                                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `e5b0718a8a`, `ad91636f0b`                             | Preserve blank ignore rules in checkpoint repositories; push the branch to its configured destination.                                              |
| `577c524089`, `bcee0f5d28`                             | Preserve pending approvals when a session detaches; settle Claude startup exits before the first SDK frame.                                         |
| `4168c14c7d`, `8d54c8b1a7`, `f12bb6229c`, `6b96956c30` | Preserve queued model selection and delegated completion cohorts across steering, restart and Stop races.                                           |
| `d756fed7aa`, `d91915db9e`                             | Include started, cancelled work in provider handoffs; deliver subsequent child results to the parent.                                               |
| `eff45664fa`, `151d5f817c`                             | Bound OpenCode command admission and wake turns blocked on questions.                                                                               |
| `c7a0931537`, `871b00907d`, `80e1e4d14d`               | Resolve Pi model identifiers containing slashes; show unread steering; retain Codex's first usage-limit reset.                                      |
| `78201b07d0`                                           | Respect project Provider policy when choosing a fallback for text generation.                                                                       |
| `077fd62222`                                           | Encode thread caches incrementally with a JSON size limit, host yielding and stale-write protection.                                                |
| `61cb845d96`, `5f2bb934d8`, `9b352a04de`, `c90b67859a` | Bound history queries, use the user-message index, narrow MCP reads and release idle search state.                                                  |
| `bbdc7dca32`, `53bcb9af7a`, `facd190640`               | Bound OpenCode and Cursor usage scans; avoid Sidebar subscriptions to terminal focus and modifier changes.                                          |
| `ad9e87111f`, `8fc6fd01d7`                             | Allow ordinary sends to await attachment uploads; preserve image previews, share HEIC decoding and delay progress indicators.                       |
| `fa2f4ff2a2`, `350ecd63be`                             | Improve touch resize handles and restore focus after closing the preview panel.                                                                     |
| `3051b32502`, `9e12eca125`, `d256170b34`               | Resolve cited file suffixes, Windows relative paths and line ranges.                                                                                |
| `d0f7a509cc`, `eb6e7fa2f6`                             | Refresh model catalogs on demand and invalidate CLI update metadata when refreshing models.                                                         |
| `bbd51f74b4`                                           | Recover Codex scratch-session project roots from its read-only state database while preserving ordinary project subdirectories and rewind identity. |
| `0e2841d5a7`, `71a1c49b75`, `3a8c250cb0`, `5be6bc99c2` | Project OpenCode native goals, todos and image jobs, plus Codex image-generation tool cards. Native goals require OpenCode 2.2.5 or newer.          |

Cox keeps model-service bindings and output budgets, project-specific OpenCode Agents,
local authentication and origin validation, desktop window privileges and upgrade rollback.
Browser caches may be discarded when too large; server history remains authoritative.
Provider streams and local task fixtures validate the native capabilities without paid
agent turns. Physical-device and live-provider acceptance are outside this release's checks.

Native mobile apps, Connect, peer/SSH/relay infrastructure and speech services remain
outside Cox's scope. The diff beta, icon overhaul and optional SDK update are deferred.
Existing desktop IPC protections are retained because Cox supports multiple windows.

Validation covers focused regressions, the complete server and Web suites, shared
packages, client-runtime, root/desktop tests, strict TypeScript, lint, formatting and
production builds. GitHub CI must pass on the release commit before publication;
published archives, npm integrity and desktop manifests are verified independently.
