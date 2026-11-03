# Changelog

## Unreleased

## 0.1.16 — 2026-11-03

- Improve phone layouts for approvals, questions, settings and workspace panels. Enlarge tab
  controls, keep narrow headers clear of panel buttons, and avoid opening the touch keyboard
  when a search or file panel opens.
- Let the system Back gesture dismiss stacked sidebar, panel and model overlays in order,
  preserving route navigation without extra history entries or unnecessary reloads.
- Add terminal touch keys for Escape, Tab, Ctrl+C and arrows, scrollable phone terminal tabs,
  and a single visible terminal pane on narrow screens.
- Keep Claude fork subagents running when their transcripts replay the launch acknowledgement.
  Parent and child elapsed timers continue updating until the subagent actually finishes.
- Disable incompatible native Codex subagents for managed ChatGPT connections, including
  model-selected multi-agent modes. Recover a rejected conversation on the next message in a
  fresh native thread while preserving Cox's task history and context.
- Honor custom Claude model context windows and refresh their capabilities when the selected
  model changes. Update the managed Codex installation to 0.166.0.
- Stop publishing Android-specific server bundles. CoCode now installs the standard npm package
  and prepares native dependencies in its own runtime. Keep previously published assets for older
  clients, and run the offline Cursor SDK smoke check against the fresh npm installation instead.

## 0.1.15 — 2026-11-02

- Show the thread's current task list in the details panel, with each step's status and the
  number of completed steps. A finished list is hidden once the next run starts, and the section
  can be turned off in the panel's display options.
- Leave context transfers out of the lineage panel when their source or target thread no longer
  exists, such as a fork discarded before it was used. They appeared as an unnamed queued row
  whose link led to a missing thread. The rows' open hints are now localized.
- Rename the password sign-in variable to `COX_AUTH_PASSWORD`. `T3CODE_AUTH_PASSWORD` still
  works, and the new name takes precedence when both are set. The README now documents password
  sign-in for personal use on a trusted internal network, with an authenticating proxy such as
  Cloudflare Access in front of Cox for internet access.
- Add a Simplified Chinese README and the bilingual project website at doublepi123.github.io.

## 0.1.14 — 2026-11-02

- Restore reasoning and other discovered options for models whose saved settings contain an
  empty `optionDescriptors` list. Older settings used it as a placeholder, but 0.1.12 treated it
  as a complete override: the picker hid the options and Claude turns dropped the selected effort.
- Saved model capabilities now replace only the values they set. Editing a context window or
  image-input support keeps discovered or fallback reasoning choices; a non-empty reasoning list
  still replaces the discovered one. Empty placeholders are removed the next time models are saved.

## 0.1.13 — 2026-11-02

- Move queued follow-up messages up or down within a thread; they are sent in the order shown.
  Controls are disabled at either end of the queue and while a move or immediate send is pending.
- Mark completed threads whose results have not been viewed with a dot beside the title,
  including completed threads that have never been opened. Viewing the thread clears it.
- Show the Cox logo and name in the sidebar and standalone pages, without the leftover "Code" suffix.
- Localize the remaining settings surfaces: descriptions, placeholders, schema-driven provider
  fields, advanced controls, diagnostics labels, theme tools, webhook filter errors and
  accessible names. Stored values, option IDs, external provider errors and raw diagnostic
  output remain unchanged.

## 0.1.12 — 2026-11-02

- Configure Codex and Claude API gateways directly in provider settings, with securely stored
  API keys and model-list refreshes. Keep subscription and API connections in separate instances.
- Edit discovered and custom models' context windows, reasoning choices and image-input support.
  Prefill explicitly reported gateway capabilities without guessing or paid inference probes.
- Give explicit Claude gateway credentials priority over local settings and subscription tokens,
  using private temporary settings files rather than exposing keys in process arguments.
- Add a delete button beside thread settlement, retaining permission checks and delete confirmation.
- Fully collapse the Working section, remember its state, and separate it from other conversations.
- Show task lists once with expandable steps instead of repeating their activity summary.
- Localize context-window controls, previous-agent groups, task counts and related pagination,
  while preserving model names and user-authored content.

## 0.1.11 — 2026-11-02

- Expand Chinese/English coverage across chat, provider settings, notifications, usage,
  thread actions and confirmation dialogs. Preserve account details and user-authored content.
- Place working threads first and expand their section initially. Queue follow-up messages by
  default, with an explicit option to steer the running agent immediately when supported.
- Preserve Codex catalog speed tiers, including Fast, through managed-provider execution.
  Availability still depends on the connected account and upstream service; no tier is invented.
- Skip subscription-limit requests for custom Codex API connections. Explain unavailable
  ChatGPT/Cursor quota data and link to their official dashboards instead of fabricating usage.
- Distinguish connecting, automatic reconnection, offline and failed states. Check connections
  when the browser window regains focus or a page is restored, and show connection diagnostics.
- Separate explicit npm token publishing from OIDC, add early authentication checks, and
  document npm installation, first use, upgrades and release authentication.

## 0.1.10 — 2026-11-01

- Phones: the system Back gesture closes the model picker sheet instead of leaving the page.
  The route and URL stay the same, and closing the sheet any other way leaves no extra history.

## 0.1.9 — 2026-11-01

- Declare the Android Cursor SDK's Alpine `gcompat` runtime requirement. Its vendored
  tree-sitter bindings target glibc; loading them without the compatibility loader fails and
  poisons SDK initialization, causing subsequent `Cannot access 'uR' before initialization` errors.
- Ship and run an offline Cursor SDK smoke test before publishing Android bundles. It exercises
  sandbox and Full Access prewarming with disposable settings, without sending model requests.
- Android hosts must install `gcompat`, including in existing environments. Update CoCode to a
  build with the corresponding installer repair; updating the Cox archive alone does not install
  Alpine packages. Server startup and authentication checks remain enabled separately.

## 0.1.8 — 2026-11-01

- Phones: the composer's model picker is now a bottom sheet with provider chips, an unfocused
  search field, a full-height model list and a pinned footer with the effort segmented control,
  speed and access. It stays usable with the soft keyboard open. Desktop is unchanged.

## 0.1.7 — 2026-11-01

- Log Cursor SDK sandbox-prewarm failures with their original cause instead of silently
  discarding them before a Full Access run. This preserves evidence of an initial module-load
  failure when a later SDK call reports a secondary initialization error.
- Keep sandbox prewarming nonfatal and shared across concurrent Full Access sessions. This
  diagnostic improvement does not claim to fix the underlying SDK initialization failure.

## 0.1.6 — 2026-11-01

- Keep the restored sign-in form compatible with React Compiler by using its supported
  asynchronous error-handling syntax, without changing credential submission or retry behavior.

## 0.1.5 — 2026-11-01

- Show the local authentication form before the chat or welcome screen when the browser is not
  signed in, instead of leaving an empty page while WebSocket authentication fails.
- Support password or pairing-token entry, rejected-credential feedback, and retry without
  losing the current route. Pairing failures from a URL are visible on the sign-in page.

## 0.1.4 — 2026-11-01

- Phones: opening the model picker no longer raises the soft keyboard (which shrank the popup and
  hid effort levels again). The search field focuses only when tapped; desktop is unchanged.

## 0.1.3 — 2026-11-01

- Phones: the model picker no longer clips content it cannot scroll to. The model list and the
  effort levels share the available height; the list shrinks first (down to its search row) so
  every effort level stays visible, and search results take priority while searching.
- Effort rows are taller on phones for touch, and the selected level scrolls into view.

## 0.1.2 — 2026-11-01

- Show active subagent instances in the thread details card, with provider instance, model,
  status, elapsed time and child-thread navigation; completed instances are removed.
- Expand Chinese/English translations for editor and script actions, Git controls, changed-file
  counts, relative timestamps and source-control settings.
- Publish the public npm package `@doublepi123/cox` automatically from version tags.

## 0.1.1 — 2026-11-01

- Publish Android-ready musl server bundles (`cox-<version>-android-linux-{arm64,x64}-musl.tar.gz`)
  with each tagged release, listed in `SHA256SUMS`. They contain the built server, Web UI and
  runtime dependencies (node-pty rebuilt for musl), run with Alpine's `nodejs` package and are
  smoke-tested for password login, the environment endpoint and the startup readiness line.
- Stabilize the real PDF worker transport test and parallelize the full CI suite.
- Retain worktrees whose Git directory pointers are invalid instead of failing cleanup.

## 0.1.0 — 2026-10-31

Initial Cox release, derived from T3 Code fork commit `0102f07afb`.

- Retain a browser interface controlling local coding-agent processes, projects, threads,
  terminals, Git/worktrees, checkpoints and local MCP integrations.
- Remove Electron, mobile clients, native device tooling and their packaging infrastructure.
- Remove T3 Connect, cloud accounts, relay/tunnel services, remote environment linking,
  guest/public sharing and client/server update endpoints.
- Use same-origin local browser authentication, HttpOnly sessions and origin-checked
  WebSockets; reject non-loopback server bindings and non-primary runtime targets.
- Isolate data in `~/.cox` (production) or checkout `.cox` (development). Refuse live T3
  state directories and symlink aliases rather than migrating or reading them.
- Default to API port 4773 and development Web port 5733. Keep provider setup/login and
  local subprocess control, without paid inference calls in automated acceptance tests.
- Add Chinese/English interface localization with device/browser language detection and
  English fallback, without rewriting agent replies or project content.
- Provide a frozen-lockfile distribution with prebuilt Web/Node code, upstream MIT license,
  third-party notices and SHA-256 checksums. Node and dependency installation remain required.

This release does not claim offline model inference, remote-control support or standalone
native binaries. Linux x64 is the initially validated platform.
