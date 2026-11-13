# Changelog

## 0.1.84 — 2026-11-13

- Count OMO Native usage: the usage page now reads OMO session transcripts,
  including model-service runtime sessions and subagent sessions, and lists OMO
  first. Model-service-bound Pi instances also report their runtime history.
- Put OMO Native first: it leads the provider list, the model picker and the Add
  provider dialog, where it is selected by default.
- Reorder providers in Settings > Providers with Move up/Move down. The order is
  saved on the server and also orders the model picker.
- Delete the default Codex and Claude providers. Deleted defaults stay removed
  after restarts and come back when added again from Add provider; resetting a
  customized default is still a separate action.
- Remove the paid AI recommendation draft and its prompt from OMO role settings.
  Use Apply official recommendations instead; saved prompts are ignored.

## 0.1.83 — 2026-11-13

- Bound sign-in requests so startup and "Signing in…" can no longer wait forever,
  and retry response-less network failures within the existing bootstrap window.
- Answer throttled password sign-ins with HTTP 429 and the remaining wait instead
  of "invalid password". Retrying during the lockout no longer extends it, and a
  successful sign-in clears earlier failures.
- Keep live connection, session and thread views following a server that was
  renamed or replaced under the same environment.
- Keep local service updates recoverable: validation failures before activation
  roll back without touching the running service, the page stays on "Restarting"
  until the helper reports, launch failures can be retried, and a failed first
  load shows the error with Retry.
- Run separate provider installs concurrently and retry undelivered browser
  profile reports.
- Translate sign-in errors, connection status titles, slow-request toasts, update
  messages and the update View action, and use neutral server wording in
  connection banners.
- Desktop client fixes (shipped with the next desktop release): Connect focuses an
  instance's existing window instead of opening another; Connections marks open
  instances and can Disconnect one without clearing its data or quitting; updated
  macOS clients that open Connections are no longer rolled back; manual update
  checks work from Connections; remote preflight errors are translated; a failed
  new-window preference save restores the saved choice.

## 0.1.82 — 2026-11-13

- Stop animating informational extension statuses such as an achieved OMO goal.
  Preserve their full text in the disclosure and animate only an explicitly
  active memory reflection, so completed work no longer appears to keep running.
- Require every native Chat stream choice to finish before accepting `[DONE]`.
  Validate successful tool-call identities and assembled JSON object arguments,
  with bounded tracking across choices and fragmented calls. Preserve incomplete
  output for length and content-filter termination and valid native legacy calls.
- Report damaged streams without replaying requests after output was delivered.

## 0.1.81 — 2026-11-13

- Stop all active gateway recovery attempts immediately when an error is not
  retryable under the configured policy, preserving the original permanent error.
- Align managed OMO stream-start, idle and HTTP timeouts with the gateway recovery
  budget plus 30 seconds, including native memory workers. Let the gateway own
  retries and apply changed recovery budgets to refreshed provider runtimes.
- Verify that the next request picks up changes to non-transient retry settings
  without a server restart.

## 0.1.80 — 2026-11-13

- Return to sign-in when the server confirms the browser session has expired or
  was revoked, instead of offering reconnects that reuse the invalid session.
- Show a retryable "Could not connect to this server" page when the first server
  discovery fails, instead of the empty-project screen. Keep loopback servers
  connecting while the browser reports no network, refresh renamed servers and
  finalize replaced connection supervisors.
- Bound first-thread and new-worktree launches by the same 60-second limit and
  same-command resend used by ordinary messages, so accepted launches are not
  reported as failed. Show thread subscription errors instead of endless syncing.
- Let local service updates be retried after a rollback, follow activation as a
  restart rather than a ready update, keep the staged update with a clear wait
  message while agent turns are active and clear transient restart errors.
- Desktop client fixes (shipped with the next desktop release): recover unreadable
  connection settings into Connections, reject overlapping connection changes,
  keep remote sessions when the inactive local backend exits, preserve windows when
  Forget cleanup fails, keep typed server details after a failed connection, stop a
  failed backend start before Retry, roll back unsaved connection changes, keep
  live macOS update reservations exclusive and remove leftover update files.

## 0.1.79 — 2026-11-13

- Apply the selected OMO model and thinking level before automatic startup or
  restored-session work begins, while preserving native defaults for inheritance.
- Retire failed OMO runs whose native input queue remains stranded after execution
  stops. Preserve live children, background work, user waits and retry activity.
- Keep the original provider error when retiring a failed native process, so the
  run ends as failed and subsequent queued Cox messages can proceed.

## 0.1.78 — 2026-11-13

- Recover requests when an upstream model explicitly rejects forced tool choice
  by retrying once with automatic tool selection, preserving messages, tools and
  reasoning settings. This fixes OMO startup failures on affected Opus 5.5 routes.
- Preserve retry limits and avoid replay after streamed output has been delivered.
  Report the specific incompatibility without exposing arbitrary upstream messages.

## 0.1.77 — 2026-11-12

- Adapt 24 selected T3 upstream commits covering ACP permission boundaries,
  contained registry installs, Git process isolation and safe commit staging.
- Preserve drafts across browser tabs, keep message identity across socket loss,
  bound unanswered sends and recover transient thread synchronization failures.
- Keep relative Markdown media on its owning server. Recognize OpenCode and Grok
  HTML results and preserve quoted HTML attributes during bootstrap injection.
- Prevent blocked providers from consuming every effect worker, settle unreadable
  recovery state, preserve Stop during provider startup and bound baseline capture.
- Recover delegated children under their own thread, retain reports preceding a
  failure, record unsuccessful scheduled runs and return delegated-task handles
  before the default HTTP deadline. See UPSTREAM_PORTING_20261112.md for scope.

## Desktop 0.2.24 — 2026-11-10

- Always open connection management in a separate window, including first launch,
  a failed startup connection and forgetting the primary remote server. Reopening
  Connections or activating a client without a primary connection focuses that
  window instead of showing a blank main window.
- Keep Connections open when opening a remote server in a new window. Update saved
  server cards without reloading the page or losing form inputs and the default-off
  new-window choice. Retain existing local tasks and isolated remote windows.
- Preserve pending-connection cancellation, closed-owner recovery, trusted-frame
  checks and restricted desktop privileges. Update native first-install and macOS
  update smoke checks for the separate connection window. Bundled Cox stays 0.1.60.

## Desktop 0.2.23 — 2026-11-10

- Add an optional "Open in a new window" choice for saved and new remote
  connections. Keep the current window by selecting it; leave it unchecked to
  replace the current connection. Additional windows do not change the next
  launch's primary connection or stop the local backend when closed.
- Keep each remote window's settings, thread navigation and permissions bound
  to its own server. Preserve server session isolation and restricted desktop
  bridges without local backend or client update privileges.
- Preserve the connection manager's target, retain the previous window when a
  pending connection is cancelled, and bring the primary window forward when
  returning to local mode.

## Desktop 0.2.22 — 2026-11-10

- Fix packaged startup by keeping the desktop navigation policy independent of
  development-only workspace runtime packages. Preserve strict editor URL checks.
- Import the emitted navigation module during production packaging preflight, and
  cover dependency-free loading outside the checkout. Publish native test runtime
  descriptors atomically to match the real backend's write behavior.
- Desktop 0.2.21 was blocked by native smoke tests and was not published.

## 0.1.60 — 2026-11-10

- Port the Cox-applicable fixes from the November 9 T3 Code upstream range.
  Preserve delegated completion delivery, report the actual Claude model, make
  Codex goal startup and reasoning more reliable, and show live Muse retries.
  Add Pi model-advertised service tiers and optional next-prompt suggestions.
- Protect stored provider secrets during duplicate-row saves, add validated
  sign-in links to private secret requests, and preserve permission boundaries
  for direct Antigravity sessions and remote desktop connections.
- Filter hidden GitHub comments and reviews; harden branch/worktree naming and
  reduce unnecessary cleanup and browser status work. Resolve unloaded thread
  links and persist compatible model selections before the next message.
- Retain existing offline database repair and automatic vacuum behavior; the
  upstream one-click reclaim is deferred pending safe native restart supervision.
- Remote desktop connections now require HTTPS with password authentication.
  Upgrade vulnerable DOMPurify, KaTeX, stream-json and undici resolutions.

## 0.1.41 — 2026-11-06

- Preserve recent thread history when stored interrupt requests and large checkpoint
  lists compete for a bounded snapshot's byte budget.
- Always treat stored provider-secret references as sensitive, including older entries
  missing the flag, and preserve that classification when saving them again.
- Synchronize thread branch metadata after worktree branch changes, including shared
  and archived threads. Ignore detached HEADs, stale branch events and moved threads.
- Refresh turn-end pull-request divergence even when background Git polling is paused.
- Avoid reopening an unreadable credential vault on unrelated settings saves. Retry
  when its configuration changes or secrets are explicitly refreshed, while preserving
  model-service materialization and working provider sessions.
- Include Pi sessions stored through an absolute `--session-dir` launch argument in
  usage reports without losing configured history directories or environment overrides.
- Allow snoozing existing unanswered questions without resolving or discarding them.
  Keep approvals visible, wake for new questions and answers, and preserve Cox's
  distinction between asynchronous questions and blocking user input.
- Retain the existing supervised first-turn policy for side chats. No mobile-only
  features, low-priority sidebar changes or broad Effect refactors are included.

## 0.1.39 — 2026-11-05

- Remove pairing codes, pairing links, bootstrap tokens and development auth
  bypasses. Default to loopback with automatic local browser sessions; require a
  password for explicitly configured numeric non-loopback listen addresses.
  Preserve source-peer, origin and WebSocket checks. MCP authorization now uses
  a server-owned browser sign-in and explicit consent flow with CSRF and PKCE.
- Authentication migration invalidates existing browser and client sessions,
  including MCP sessions. Sign in or approve clients again after upgrading.
  Password changes also invalidate sessions. Back up the Cox data directory
  before upgrading; downgrading requires its matching pre-upgrade backup.
- Discover OpenCode 2 visible primary/all agents per project, including plugin
  agents. Honor explicit selections and otherwise preserve the native session
  default. Plan mode temporarily takes priority; returning to normal restores
  the selected or original agent without changing the chosen model/provider.
- Display workflow cache reuse separately from execution, preserving known
  original durations across snapshots and showing an unknown original duration
  for legacy caches instead of a misleading zero. The external Claude runtime's
  native journal still omits execution timing; Cox cannot recover that missing
  history, and native persistence requires an upstream runtime fix.
- Make the retry-on-429 option ignore upstream cooldowns, removing the separate
  cooldown toggle while retaining local backoff and retry limits. Default recovery
  budgets to 600 seconds, response-header timeouts to 300 seconds and concurrent
  requests to 5, with a maximum of 10. Preserve explicit saved custom settings.
- Fix recovery numeric inputs so values can be cleared while editing, including
  the last zero; invalid or empty values revert on blur.

## 0.1.38 — 2026-11-05

- Report model-service recovery budget exhaustion as HTTP 504 with a distinct
  termination reason, elapsed time, attempt count and the last attempt failure.
  Preserve the result when a native SDK reconnects with the same request.
- Keep surviving in-flight requests running when a competing attempt fails
  permanently, while stopping additional attempts for that recovery.
- Make each attempt's response-header timeout configurable, defaulting to 120
  seconds and bounded by the shared recovery budget. Preserve long output streams.
- Default backup delays to 30 seconds for ordinary requests and 60 seconds for
  reasoning requests. Preserve explicitly configured service delays.
- Log effective recovery policies, backup suppression reasons, response-header
  and usable-output timing, attempt results and cancellation causes without
  recording request bodies or credentials. Distinguish terminal causes in the UI.

## 0.1.37 — 2026-11-05

- Keep model-gateway requests from background agents and workflows running when
  their parent turn completes or another turn starts in the same provider session.
- Separate session cancellation from turn progress and failure tracking. Preserve
  explicit stop and session-close cancellation without cancelling sibling requests
  when one child request ends.
- Report explicit gateway cancellation with a structured, non-retryable error before
  output starts and protocol-specific error events after streaming output begins.

## 0.1.36 — 2026-11-05

- Disable Claude's built-in WebSearch for model-center sessions while preserving
  existing tool restrictions and normal Claude provider behavior.
- Read the Settings version from the root release manifest so the browser and
  published npm package display the same release version.

## 0.1.35 — 2026-11-05

- Add an opt-in switch to retry all model-service HTTP 429 responses, including quota
  errors previously treated as permanent. Retain the configured attempt and time limits,
  and control Retry-After waiting separately through the existing cooldown setting.
- Add an independent opt-in switch to retry failed requests containing upstream tools
  such as web search before output starts. Retry these requests sequentially and retain
  the existing limits for background and stateful requests.
- Recognize embedded 429 errors in successful HTTP responses and streams, preserve older
  service settings, and cover the switches with gateway, budget and settings regressions.

## 0.1.34 — 2026-11-05

- Recover transient model-service failures with configurable aggressive retries and
  delayed backup requests when no usable output arrives. Share attempt, time and
  concurrency limits, select the first usable response, and cancel losing requests.
- Configure retries and backups independently for each model service, including normal
  and reasoning response thresholds and whether to respect upstream retry cooldowns.
- Show recovery progress in the session, correlate requests with their active turns,
  and prevent native SDK retries from restarting an exhausted gateway recovery budget.
- Preserve stream output and tool-call delivery, cancel recovery when a turn stops or
  a service is disabled, and migrate older shared sessions to dedicated sessions where
  required without losing their native conversation history.

## 0.1.33 — 2026-11-05

- Keep thread subscriptions recoverable after stream defects and preserve older pending
  questions through bounded snapshots, cached state recovery and history pagination.
- Preserve sibling task completion wakeups when interrupting a delivered completion, and
  protect native background work during queued provider switches. Attribute automatic
  usage-limit continuations to Cox without losing delegated follow-up tracking.
- Isolate stale provider refresh results, recover Codex sharing-limit errors with the
  existing controls, classify Cursor text-generation limits, and retire silent Antigravity
  prompts with an opt-in inactivity watchdog that respects active tools and approvals.
- Make styled Markdown markers editable without discarding the existing IME behavior,
  save pull-request description task checkboxes, and render supported Claude MCP Apps
  through the current session with conservative permissions and older-CLI fallback.
- Validate terminal file links against filesystem metadata, show worktree setup status,
  retain touch message navigation when space permits, and label Changes totals correctly.
- Add optional ghq-style clone folders, GitHub Enterprise PR checkout URLs and standard
  submodule patches regardless of user diff settings.
- Stabilize blocked-repository scanner tests and PDF preview load synchronization while
  keeping all changes local-only and retaining Cox model-service isolation.

## 0.1.32 — 2026-11-05

- Port high-value upstream T3 Code fixes: retry unstarted runs after recovery, avoid
  message-ordering scans during recovery/settlement, load selected diff metadata before
  patches, cut long-thread work-row derivation, list Claude Code reported models, and show
  MCP/OpenCode tool-output images.
- Also port auto-settle after dismissed link cards, review-guide hook isolation, MCP SSE
  CR/mixed newlines, Claude context windows for non-catalog models, PR-watch conflict wakes,
  project-disabled provider filtering in `orchestrator_capabilities`, child worktree cleanup
  on settle, OpenCode command/status/stall fixes, ACP multi-diff and post-rollback events,
  preview setup failure cleanup, Antigravity sign-in startup errors, delegated event-log
  isolation, and closed-PR sync pruning.
- Fix the port's diff-panel integration so deferred patches load beyond the first batch,
  selected files expand on the first click, and comparison errors remain recoverable.
- Keep Claude model-service catalogs exclusive, resolve reported context windows against
  the instance catalog, and exclude restored session history from new-turn usage totals.
- Preserve readable tool-image summaries beside structured metadata without rendering
  mirrored image bytes, and align restart-continuation test doubles with recovery reads.

## 0.1.31 — 2026-11-04

- Automatically offer native Codex Ultra for every model declaring a Max reasoning level,
  including model-center, custom and cached catalogs. Preserve explicit model capabilities,
  defaults and saved selections while enabling Codex's native Ultra mode.
- Enable real Claude Code Ultracode workflows, including model-center models declaring
  xhigh. Pass the native workflow settings and xhigh effort instead of aliasing Ultra to
  Max; retain compatible saved selections and show Ultracode distinctly in the composer.
- Normalize unsupported GPT Ultra wire values to Max after model-service protocol
  conversion for OpenAI Chat Completions and Responses. Preserve unrelated vendor efforts
  and expose only safe, allowlisted diagnostics for the confirmed HTTP 400 rejection.
- Cover model catalogs, native provider requests, workflow selection, protocol conversions
  and saved composer state. Verify actual Codex Ultra and Claude Ultracode workflow events
  against isolated loopback endpoints without paid inference or live application data.

## 0.1.30 — 2026-11-04

- Add a Queue / Steer preference menu beside the model picker in the composer footer.
  Share the saved setting with the settings page, keep one-message overrides, and do not
  send a message when changing the preference. Fit narrow English and Chinese layouts.
- Automatically choose an auxiliary text model from the configured agent's available
  model-service binding instead of sending an unsupported built-in model to the gateway.
  Keep valid manual selections and their options, without persisting automatic fallbacks.
- Use the same model-selection rules in settings, project overrides and text-generation
  requests. Prefer configured bindings over an untouched stock default, drop stale model
  options on replacement, and honor actual model catalogs during usage-limit fallback.
- Cover saved preference changes, keyboard and focus handling, mobile footer measurements,
  bound model defaults, provider setup, project-only agents and text-generation preflight
  without using live application data or paid inference.

## 0.1.29 — 2026-11-04

- Resume restart-held user queues after their matching continuation completes, including
  repeated restarts and recovery between completion and queue release. Preserve manual
  holds and do not release queues after a stop, failed continuation or pending request.
- Keep model-center Codex catalogs authoritative instead of filtering their models out as
  custom entries. Preserve instance visibility preferences and exclude stale custom lists.
- Preserve explicitly declared service tiers for Codex and Claude through model catalogs,
  picker controls and outgoing requests. Add editable service tiers to model-center entries
  without assuming that third-party channels support Fast processing.
- Forward Claude service-tier selections through the request body and reopen the native
  query when the tier changes. Keep channel routing separate from Claude's native Fast mode.
- Use completion-token limits for reasoning-model Chat Completions conversions and retain
  service tiers across OpenAI protocol conversions. Expose only allowlisted rejection
  parameter roots and error codes, with bounded error-body reads and no inference retries.

## 0.1.27 — 2026-11-04

- Preserve model-service reasoning levels reported for Codex, including `max` and `ultra`, in
  model controls, native catalogs and outgoing requests.
- Add editable reasoning levels to model-center entries, with English and Chinese labels.
  Keep existing option labels, descriptions and defaults when editing the supported levels.
- Verify that repeated model-list refreshes and metadata enrichment preserve manually edited
  reasoning levels, including explicitly cleared lists, when upstream metadata differs.

## 0.1.26 — 2026-11-04

- Simplify the model service editor with a single card, consistent protocol controls and
  phone-sized save actions.
- Add a two-column desktop connection and protocol layout with a clearer model catalog.
- Cover 320px, 390px and desktop model-service layouts with browser tests.
- Suppress unavailable reasoning placeholders from the v0.1.25 release.

## 0.1.24 — 2026-11-03

- Sync recent upstream T3 Code fixes for Claude, Codex, Cursor, OpenCode, Pi, Git, preview and
  orchestration, including Pi short-lived `--offline` OAuth safety, OpenCode 2 upgrade probing,
  `diff.relative` subdirectory commit/PR context, and command-palette project opens that skip
  side chats and subagents.
- Replace the phone settings section dropdown with a first-level menu on `/settings`. Opening a
  section shows its page with a back control; desktop still lands on General.
- Keep copied markdown code blocks' blank lines, and open the project picker from the boring
  sidebar header instead of starting a thread in the current project.

## 0.1.21 — 2026-11-03

- Add a model service center for shared base URLs, API keys and model catalogs. Bind agent
  providers to a service and translate OpenAI Responses, Chat Completions, Anthropic Messages
  and Gemini requests with the embedded CLIProxyAPI SDK when protocols differ.
- Fill model names, context windows, output limits and modality, tool and reasoning metadata
  from models.dev using exact model IDs, preserving explicit provider and user values.
- Install and configure Pi from provider settings, including managed binaries and model
  service bindings, while preserving existing custom installations.
- Allow custom worktree names. When omitted, recommend a name from the first message before
  creating the checkout, with a bounded wait and random fallback. Localize the workspace row.
- Keep Pinyin composition active through consecutive Backspace presses and delayed composer
  updates, and prevent editor shortcuts from interrupting an active input method.

## 0.1.20 — 2026-11-03

- Install the official Grok CLI and sign in or out of Grok Build directly from provider
  settings, with installation progress, cancellation, retries and device authorization.
- Keep existing custom Grok binaries and API-key authentication working. Install managed
  binaries atomically in Cox's tools directory and preserve the previous binary on failure.
- Show the Grok update action only when a newer version is confirmed, while retaining
  installation retries after failures or cancellation.
- Fix nine settings-panel style lint errors while preserving the existing layout.

## 0.1.19 — 2026-11-03

- Fix promote-to-steer so a queued message keeps its own model selection, restoring
  timeline model and reasoning-effort dividers when the turn restarts.
- Refresh the MCP tool-list context budget after the bulk pull-request tools landed,
  and correct the 0.1.18 changelog names for `link_pull_requests` and
  `unlink_pull_requests`.

## 0.1.18 — 2026-11-03

- Surface pending tool and command approvals from active child threads directly above the
  parent thread composer, with full English and Simplified Chinese localization.
- Show concise system dividers in the conversation timeline when switching models or reasoning
  effort within the same harness.
- Enhance MCP preview and pull-request tools: `preview_open` accepts a dev-server `port`
  directly, `link_pull_requests` links multiple PRs in one call, and `unlink_pull_requests`
  unlinks all PRs matching given states in one call.
- Improve Claude Code, Codex, Cursor, OpenCode, Antigravity and ACP adapter stability: prevent
  Claude interrupt hangs, close withdrawn approval cards, strip inherited `CLAUDE_CODE_SESSION_ID`
  and disable throwaway transcript persistence for text generation; respect per-instance
  `CODEX_HOME`, handle split UTF-8 emoji tails in Codex background wakes, and guard Cursor SDK
  `write-after-end` errors.
- Harden Git worktree creation, branch rebinding, restart recovery, and runtime performance
  across SQLite statement caching, streaming diffs, file-tree search, and terminal I/O.

## 0.1.17 — 2026-11-03

- Replace the phone settings tab strip with a grouped section picker and a separate search
  button. Keep the search field visible while results scroll, distinguish clearing from
  closing search, and show an input hint when the search is empty.
- Remove the duplicate section title from the phone settings header. Improve narrow-screen
  spacing, long labels, theme previews and inline switches while preserving desktop columns.
- Enlarge phone settings inputs, number controls, section actions and dialog buttons to
  44-pixel touch targets. Fit selects to narrow screens and avoid keyboard zoom in search.

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
