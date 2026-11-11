<p align="center">
  <img src="apps/web/public/cox.svg" width="96" height="96" alt="Cox icon" />
</p>

# Cox

English | [简体中文](README.zh-CN.md)

[Website](https://doublepi.dev/) · [CoCode for Android](https://doublepi.dev/cocode/)

Cox is a Web interface and desktop client for coding agents, derived from [T3 Code](https://github.com/pingdotgg/t3code), starting at `0102f07afb` in the `doublepi123/t3code` fork.

Run the server on your computer and control your locally installed coding agents from a browser. Your projects, conversation history, credentials and checkpoints stay in your local Cox data directory.

## Project website

The product homepage is [doublepi.dev](https://doublepi.dev/), with the
[CoCode Android page](https://doublepi.dev/cocode/) under the same GitHub Pages site.
The bilingual website source lives in [`site/`](site/README.md), with a responsive
feature showcase, an illustrative workspace, and copyable installation commands.
It is separate from the local Cox application and does not host agents or user data.
Run `pnpm pages:test` and `pnpm pages:build` to validate and build it. See the
[website deployment guide](site/README.md#account-homepage) for account-homepage and optional project Pages deployment.

## Quick start (npm)

### Desktop client (macOS / Windows)

The optional [Cox Desktop client](apps/desktop/README.md) embeds the existing Web UI,
a standalone Node runtime and a loopback-only backend. It can also connect directly to a
user-operated Cox server over HTTPS with password authentication. Desktop builds launch by
double-clicking and use `~/.cox/desktop`, separately from CLI data. Build installers
on the target operating system with `pnpm desktop:build`; signing and native-platform
acceptance are required before public distribution. Agent installation and authentication
remain separate. The browser/CLI workflow below is unchanged.

### CLI installation

The public npm package is [`@doublepi123/cox`](https://www.npmjs.com/package/@doublepi123/cox).
Use Node.js `26.12.1` (the version tested in CI) and npm. A source checkout and pnpm are
not required: the package includes the built browser UI and local server.

```sh
npm install --global @doublepi123/cox@latest
cox
```

Alternatively, run the latest package without a global installation:

```sh
npx @doublepi123/cox@latest
```

### First run

1. Keep the terminal running. Cox starts a loopback-only server and opens your browser.
   If it does not open, follow the local URL and authentication instructions printed in
   the terminal; do not share authentication links or tokens.
2. Configure a supported provider in **Settings**. CLI-backed providers need their agent
   CLI installed and authenticated locally; installing Cox does not install every agent
   or include a model subscription or API credits.
3. Add a local project directory, create a thread, select a provider/model and send a message.

Production data defaults to `~/.cox`. Keep that directory private: it holds local state,
including conversation history and credentials. Cox does not migrate data from `~/.t3`.

### Common commands

```sh
cox --help
cox --version
cox --no-browser
cox --host 127.0.0.1 --port 3773
cox --home-dir "$HOME/.cox-test" --port 3774
```

Use the URL printed by the server rather than assuming a fixed port. `--no-browser` only
disables automatic browser opening; local authentication still applies. `--home-dir`
selects a separate data directory, useful for an isolated test installation.

### Upgrade

Wait for active agent turns to finish, then stop Cox (`Ctrl+C` when running in a terminal).
Update the package and start it again:

```sh
npm install --global @doublepi123/cox@latest
cox --version
cox
```

Use the same data directory and startup flags to retain your existing workspace. Back up
your Cox data directory while the server is stopped before upgrading. If you manage Cox
with a service manager, update that service's actual installation and restart it through
the service manager instead of starting a second server.

Allow npm install scripts so Cox can apply its runtime dependency patches. Native
dependencies may need a local C/C++ build toolchain when prebuilt binaries are unavailable.
If `cox` is not found after a global install, check that npm's global executable directory
is on your `PATH`, or use the `npx` command above.

For a Linux deployment managed by the `cox.service` systemd user unit, the server can opt into
browser-driven updates from both local and connected desktop clients with
browser-driven updates with `Environment=COX_LOCAL_SERVICE_UPDATE=1` and an update unit template at
`~/.cox/local-service-update/unit`. Copy the actual `ExecStart` line and replace its `dist/bin.mjs`
path with `__COX_ENTRY__`; keep every other startup flag and environment setting unchanged.
**Settings → About** then offers an authenticated
check, official npm download and SHA-512 verification, a consistent SQLite/settings backup, and a
confirmed service restart. A transient user-level helper performs the handoff and restores the
previous unit if the target version does not become healthy. Cox refuses this path for development
checkouts, desktop-managed backends, non-systemd processes, active agent turns, and releases whose
database migration frontier differs from the current database. Those releases require the manual
stopped-server backup and upgrade procedure above.

## Scope

- Web UI and a local Node HTTP/WebSocket server.
- Local agent providers, projects, threads, streaming chat, terminal sessions, Git/worktrees and checkpoints.
- Electron desktop clients for macOS and Windows; no React Native/iOS/Android app or app-store distribution.
- Direct desktop connections to user-operated Cox servers; no T3 Connect, Clerk cloud account, relay, tunnel service, hosted app, server discovery or managed remote environments.
- No upstream release/update service or automatic migration from a T3 installation.

Local-by-default does not mean offline inference. Agent providers still use their configured model services, and Git integrations can contact your configured repository hosts. Provider authentication and local credential storage are retained.

## Interface language

Cox supports Simplified Chinese and English. The initial interface follows supported
device/browser language preferences; Chinese preferences use Chinese, with English as the
fallback for other languages. Language selection affects Cox's interface, not project files,
agent replies, terminal output or user-authored content.

Use **Settings → General → Language** to choose English, 简体中文 or the device default.
The selection is saved in the browser and updates the interface without discarding drafts.
Settings, including advanced controls and schema-driven provider fields, follow the selection.
External provider errors, raw diagnostic output and provider-supplied model descriptions keep
their original text; see the [localization notes](apps/web/src/i18n/README.md) for coverage and
contribution guidance.

## Thread interactions

Working threads appear above pinned and active threads. The Working section starts expanded;
an explicit expand/collapse choice is remembered in the browser.
Messages sent during an active turn queue by default. Use the menu beside Send to choose
**Steer now** when immediate guidance is needed. An existing explicit follow-up preference
is preserved; steering is unavailable while the agent cannot accept it.
Move queued messages up or down to change the order in which they are sent. A dot beside a
thread title marks a completed result you have not viewed yet.

Styled inline Markdown markers in the composer are editable: move into formatted text to
edit its delimiters, then move outside to restore the formatted view. PR description task
checkboxes save when the connected account and local connection both permit editing.

In **Settings → Threads → New projects**, enable **Clone into host folders** to default new
clones to `<base directory>/<host>/<owner>/<repository>`, like ghq. It is off by default and
does not move existing checkouts. Unsafe or local URLs keep the ordinary repository-folder
fallback. Supported Claude Code versions can render MCP Apps from connected tools using
the current session; older CLIs keep ordinary tool output, and app calls respect permissions.

## Requirements

- Node.js `26.12.1` (tested); npm for the published package, or pnpm `12.14.0` for source development and GitHub Release archives.
- Git and a supported agent provider configured locally. CLI-backed providers need their agent CLI installed and authenticated (for example Codex or Claude Code).
- A C/C++ build toolchain may be needed if a native dependency has no prebuilt binary for your platform.

## Subscription limits and Codex speed

In **Usage → Limits**, Cox shows remaining percentages and reset times when the connected
provider reports them. Missing quota data is not treated as an unused allowance.
ChatGPT plan sharing currently has no remaining-quota reader in Cox. Cursor SDK/API
credentials alone also do not provide the dashboard token used by Cox's quota reader;
Cox will not substitute another account's local login. These connections show the reason
and a link to the provider's usage dashboard instead. Use the connected account there.
API-key and custom API connections do not run ChatGPT subscription-limit queries.

### API gateways and custom models

For a shared connection, open **Settings → Model services**, add the base URL, API key and
supported protocols, then choose **Save and fetch models**. Model discovery reads metadata
only. You can also add or edit model metadata manually when a service has no model-list API.
In **Settings → Providers**, bind a Codex, Claude Code, Pi, OMO Native or OpenCode instance to the service,
select its models and a default. Unbinding restores that instance's independent settings.

Each service's **Request recovery** settings include an opt-in **Retry non-transient upstream
errors (e.g. HTTP 400)** switch, disabled by default for existing and new services. With
automatic retries enabled, it also retries upstream 4xx/5xx failures (including invalid
requests and authentication errors) before output starts. The separate 429 and upstream-tool
switches still apply, as do attempt/time budgets, cancellation and stateful-request limits.
Local gateway validation failures are not overridden; permanent upstream errors may waste usage.

OpenCode 2 discovers visible primary agents from each project's directory, including plugin
agents. In normal mode, an explicit Agent selection overrides the native session agent;
without a selection, Cox preserves the native default chosen when the session is created.
Plan mode temporarily selects `plan`, taking priority over the Agent selector. Returning to
normal mode restores the explicit selection or the session's original native agent. Switching
agents does not authorize switching away from the model and provider selected in Cox.

Workflow cache hits display a cache-reuse label and the original execution duration when
the provider supplies it. Legacy caches without execution timing display an unknown original
duration; cache-return timestamps are never treated as execution or cache-read durations.
Cox preserves cache metadata in stored snapshots, but cannot recover timings omitted by
the external Claude runtime's native journal. Persisting those timings for new native cache
entries requires a corrected upstream runtime, including its journal writer, reader and replay.

Cox keeps upstream keys and private headers in its local secret store. Agents receive
separate local gateway credentials. Native protocol requests pass through; other requests
use the embedded MIT-licensed [CLIProxyAPI translator SDK](https://github.com/router-for-me/CLIProxyAPI)
for OpenAI Responses, Chat Completions, Anthropic Messages and Gemini, including streaming
and tool calls. Conversion cannot add model capabilities. Stateful Responses conversion
requires complete conversation input; cross-protocol token counting is unavailable.
Credential rotation takes effect centrally. Finish active turns before changing bindings
or model catalogs, because provider configuration changes can recreate agent sessions.

In **Settings → Providers**, open a Codex or Claude instance and configure **API gateway → API URL / API key**. Keys are stored separately on the local host and are not returned to the browser as plaintext. These settings take precedence over subscription authentication for that instance; use separate instances to keep API and subscription connections available together. Codex gateways must support the OpenAI Responses API; Claude gateways must support the Anthropic Messages API.

Save the settings, then choose **Refresh models from gateway** under **Models**. Cox reads the gateway's model-list endpoint (including pagination), without sending paid inference probes. Model IDs, names, context limits, reasoning choices and image-input support are filled only when reported by the gateway. Many `/models` endpoints report only IDs, so unknown capabilities remain unset.

Use a model's edit button to override its context window (tokens), image-input support, or reasoning choices. Overrides are saved per instance and take precedence over subsequent discovery; they do not grant capabilities the upstream model lacks. Each override replaces only the values it sets: unset values, including empty reasoning lists saved by older settings, keep the discovered ones. Clearing the gateway settings restores the instance's original authentication configuration. Existing threads may need a new session to use changed connection settings.

Managed Codex preserves the speed tiers reported by its model catalog and forwards the
selected tier, including Fast, to app-server. Catalog entries are not proof of entitlement;
the upstream service can reject a tier for a particular account or connection. Cox does not
silently retry with a different tier.
Account-catalog speed options fill gaps in native model discovery without discarding
native model settings. Cox does not advertise Fast when neither catalog reports it.

### OMO Native

OMO Native is an independent, disabled-by-default provider. Install the OMO Native CLI,
then enable it in **Settings → Providers** and set **Binary path** to `omo` or its absolute
path. Independent instances can use native credentials and configuration.

Bind OMO Native to one model service to share its available tool-capable models. Cox writes
an isolated `model-services/runtime/<instance>/omo/models.json` and session directory under
its state directory. Models keep their exact upstream IDs with a `cox/` slug prefix.
**OMO native roles** assigns models to agents and categories; empty assignments inherit the
main model. The binding default can also be left empty to use the first available model.
Use **Apply OMO models** to save the binding, main default and role assignments together.
Custom role names start with a letter and contain only letters, digits, underscores or
hyphens, up to 64 characters. Reserved object property names are rejected.

Managed roles can select only available models from that instance's service binding.
Before removing or ignoring a referenced model, clear or reassign its roles. If an explicitly
selected role or main model becomes unavailable, Cox reports an error and preserves the
selection so it can be repaired in settings. It does not silently choose another role model.

## Development

Source builds require Go `1.27.3` in addition to Node and pnpm. Run
`node scripts/build-protocol-bridge.ts` before using protocol conversion in development,
and `pnpm test:protocol-bridge` to test the converter. `pnpm build` builds it automatically;
published packages include the native converter and do not require Go. See
[`native/protocol-bridge/README.md`](native/protocol-bridge/README.md) for packaging and limits.

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5733`. Follow the local authentication flow printed by the server. The development server proxies API and WebSocket requests to `127.0.0.1:4773`; do not set `VITE_HTTP_URL` or `VITE_WS_URL`.

Development state is isolated in this checkout's `.cox/`. It does not read or seed from `~/.t3`. Use `COX_SERVER_PORT` and `COX_WEB_PORT` in your environment or `.env` to change ports. `pnpm dev:server` and `pnpm dev:web` run either half separately.

## Production

For the npm installation and upgrade commands, see [Quick start (npm)](#quick-start-npm).

For a GitHub Release, download `cox-v<VERSION>.tar.gz` and `SHA256SUMS`, verify the checksum,
extract the archive, and run `pnpm install --frozen-lockfile` followed by `pnpm start`.
The release asset includes prebuilt Web/server code but not Node or dependencies. Linux x64
is the initially validated platform. See [RELEASING.md](RELEASING.md) for details.

When building from a source checkout instead:

```sh
pnpm build
pnpm start
```

The local server serves the built Web app and its API from one origin. Use the local browser URL printed on startup. Production data defaults to `~/.cox`; `--home-dir` selects a different Cox data directory. Run `pnpm --filter cox start --help` for CLI options.

Cox listens on `127.0.0.1` by default and must not be exposed directly to an untrusted network. To reach it from another device, see [Password sign-in and remote access](#password-sign-in-and-remote-access). Local authentication and origin checks remain necessary because agent access includes filesystem and terminal operations.

## Desktop clients

The desktop shell and Cox backend have independent versions. Cox releases use root/server
versions and `v<VERSION>` tags; desktop releases use `apps/desktop/package.json` and
`desktop-v<VERSION>` tags.

Choose **Connections** in the native menu to switch between this computer and a saved remote
server. Remote entries require an HTTPS origin such as `https://cox.example.com`; the server must
also be configured with `COX_AUTH_PASSWORD`. Credentials in URLs, plain HTTP and certificate-error
bypasses are rejected. The remote server supplies its own matching Web UI and uses the normal
Cox password page and same-origin HTTPS/WSS API/WebSocket connections. Passwords are not saved in the
desktop connection file. Each server has an isolated browser profile, and forgetting it clears
that profile's local session and cached data. Remote pages cannot manage the local backend or
desktop updates. Local and remote instances can stay available at the same time; switching to a
remote server does not stop the local backend or its tasks. Disconnecting or quitting remote mode
does not stop server-side agents or terminals. Third-party
SSO redirects from an authenticating proxy are not embedded in the desktop window.

- Combined installers include both versions in their filenames: for example,
  `cox-desktop-0.2.7-cox-0.1.45-mac-arm64.dmg`. macOS releases provide DMG installers only, without duplicate ZIP packages.
- Client-only installers, such as `cox-desktop-0.2.7-client-only-win-x64.exe`, include the browser shell,
  standalone Node and npm, but **no Cox backend**. Their first local session needs internet access
  to install the latest stable `@doublepi123/cox`; choosing a remote server does not install a local
  backend. No global Node/npm/Cox installation is needed.
  A failed initial download offers Retry/Quit; subsequent launches use the verified local
  installation and can run offline (`--offline` disables update checks).
- The client checks for Cox updates at startup and every six hours. Settings → About shows
  the client, installed Cox and bundled Cox versions separately and allows manual checks.
  Older Cox browser builds retain the native menu's update-check fallback.
- Updates verify the official npm package name, fixed HTTPS registry URL, SHA-512 and
  desktop/Node compatibility, then smoke-test an isolated installation. Downloading does not
  stop running tasks. A staged update activates on the **next normal launch**.
- Backend binaries live in `~/.cox/desktop/backend-updates`, never inside the signed `.app`.
  Bundled backends are cached there too: a newer combination installer activates its newer
  Cox, while an older bundle cannot replace a newer managed installation. Switching to a
  client-only installer retains an already cached backend even when offline.
  Before activation, with no previous backend alive, the client snapshots desktop userdata.
  Failed/interrupted activation restores the old backend **and its matching data snapshot**;
  it never starts older code against a partially migrated database. The current and previous
  managed binaries and latest recovery backup are retained.

Each stable Cox npm publication automatically builds a latest-Cox/latest-released-client
combination. Each desktop release builds that combination **and** client-only installers for
macOS ARM/Intel and Windows. Packages are published only after all native checks pass.
The first independent desktop release must be published before Cox-triggered combination
builds can select it. See [RELEASING.md](RELEASING.md#desktop-release-matrix).

## Password sign-in and remote access

Cox defaults to loopback (`127.0.0.1`). Without a password, the local browser automatically establishes a session; no token or pairing link is needed. Never expose this local-no-password mode through a reverse proxy, tunnel, or port forward.

To require sign-in, set a password of at least 8 characters before starting Cox:

```sh
COX_AUTH_PASSWORD='use-a-long-random-password' cox --no-browser
```

The password protects localhost as well as external access. Configuring a password never changes the listen address automatically. A browser stays signed in for up to 30 days. After 10 failed attempts within 5 minutes, password sign-in pauses until that window passes. When a service manager runs Cox, keep the variable in an environment file that only you can read rather than on the command line. The previous name, `T3CODE_AUTH_PASSWORD`, is still accepted.

To listen beyond loopback, explicitly pass `--host 0.0.0.0`, `--host ::`, or a numeric IPv4/IPv6 address together with `COX_AUTH_PASSWORD`; DNS hostnames other than `localhost` are rejected. Development Web URLs remain restricted to loopback. Use HTTPS for nonlocal browser access, typically with a TLS reverse proxy forwarding to Cox. The desktop client requires HTTPS and password authentication for remote connections. CLI `auth session issue/list/revoke` commands are a trusted local control plane: they reuse the persisted authentication policy without changing it, even when the shell does not inherit the service's password environment.

Password sign-in is meant for personal use on a trusted internal network. Do not rely on it alone on the public internet: the password would be the only barrier in front of agents that run commands and edit files. For internet access, put an authenticating proxy in front of Cox, such as Cloudflare Access with Cloudflare Tunnel, or a similar identity-aware proxy or VPN, and keep the password as a second layer. The proxy must use HTTPS, support WebSockets, and preserve the public host in `Host`; untrusted forwarded headers do not authorize browser origins.

Upgrading from pairing authentication invalidates existing browser and client sessions, including MCP clients; sign in or approve clients again. Projects, threads, messages, and provider credentials are preserved. Changing or removing the server password also invalidates existing sessions. Back up the Cox data directory before upgrading; downgrading across this authentication migration requires restoring the matching pre-upgrade backup.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

Package tests can also be run with `pnpm exec vp test run <test-file>`.

The full server suite (`pnpm --filter cox test`) additionally needs a C compiler for native-launcher fixtures and Playwright Chromium with its platform libraries for headless browser tests. Install the browser with `pnpm --filter cox exec playwright-core install chromium`; these are test prerequisites, not desktop-client components.

## npm publishing

The `Publish npm package` workflow (`.github/workflows/npm-publish.yml`) defaults to npm Trusted Publishing (OIDC) on GitHub-hosted runners. Tag-triggered publishing uses OIDC; the `token` option is only an explicit bootstrap fallback, never an automatic retry.

In the npm settings for `@doublepi123/cox`, configure a GitHub Actions trusted publisher with organization/user `doublepi123`, repository `cox`, and workflow filename `npm-publish.yml`. Leave the environment field empty unless the workflow is also configured to use that GitHub environment. This npm-side trust binding is separate from the checked-in workflow and cannot be inferred from `id-token: write` alone.

After the binding is configured, publish through the workflow with `authentication=oidc`; no `NPM_TOKEN` repository secret is required for that mode. Local `npm publish` does not inherit GitHub's OIDC identity. Do not remove an existing bootstrap token until a real workflow publish has verified the trust binding. Version tags and package publication remain explicit release operations, not part of desktop test builds.

## Layout

- `apps/web`: browser UI.
- `apps/server`: local API, agent processes and orchestration.
- `packages/client-runtime`: browser state and local connection runtime.
- `packages/contracts`, `packages/shared`: wire contracts and shared utilities.
- `packages/provider-*`: local agent adapters.
- `packages/source-control-*`: Git hosting integrations used with local projects.

Internal `@t3tools/*` package identifiers are retained to keep the derived source compatible; they do not imply a connection to T3 cloud services.

The Cox icon is maintained in `apps/web/public/cox.svg` and reused by the interface, splash
and browser favicon. After editing it, run `node scripts/generate-icons.mjs` to regenerate
the PNG and ICO variants. This maintenance command requires Playwright's headless Chromium.

## Attribution

This project retains the upstream MIT license and third-party notices. See [LICENSE](LICENSE). Cox is a derivative project, not an official T3 release.
