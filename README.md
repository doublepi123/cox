# Cox

English | [简体中文](README.zh-CN.md)

Cox is a local Web interface for coding agents, derived from [T3 Code](https://github.com/pingdotgg/t3code), starting at `0102f07afb` in the `doublepi123/t3code` fork.

Run the server on your computer and control your locally installed coding agents from a browser. Your projects, conversation history, credentials and checkpoints stay in your local Cox data directory.

## Project website

The product homepage is [doublepi123.github.io](https://doublepi123.github.io/).
The bilingual website source lives in [`site/`](site/README.md), with a responsive
feature showcase, an illustrative workspace, and copyable installation commands.
It is separate from the local Cox application and does not host agents or user data.
Run `pnpm pages:test` and `pnpm pages:build` to validate and build it. See the
[website deployment guide](site/README.md#account-homepage) for account-homepage and optional project Pages deployment.

## Quick start (npm)

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

## Scope

- Web UI and a local Node HTTP/WebSocket server.
- Local agent providers, projects, threads, streaming chat, terminal sessions, Git/worktrees and checkpoints.
- No Electron desktop app, React Native/iOS/Android app or app-store distribution.
- No T3 Connect, Clerk cloud account, relay, tunnel service, hosted app or linked remote environments.
- No upstream release/update service or automatic migration from a T3 installation.

Local-only refers to the control plane, not offline inference. Agent providers still use their configured model services, and Git integrations can contact your configured repository hosts. Provider authentication and local credential storage are retained.

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

In **Settings → Providers**, open a Codex or Claude instance and configure **API gateway → API URL / API key**. Keys are stored separately on the local host and are not returned to the browser as plaintext. These settings take precedence over subscription authentication for that instance; use separate instances to keep API and subscription connections available together. Codex gateways must support the OpenAI Responses API; Claude gateways must support the Anthropic Messages API.

Save the settings, then choose **Refresh models from gateway** under **Models**. Cox reads the gateway's model-list endpoint (including pagination), without sending paid inference probes. Model IDs, names, context limits, reasoning choices and image-input support are filled only when reported by the gateway. Many `/models` endpoints report only IDs, so unknown capabilities remain unset.

Use a model's edit button to override its context window (tokens), image-input support, or reasoning choices. Overrides are saved per instance and take precedence over subsequent discovery; they do not grant capabilities the upstream model lacks. Each override replaces only the values it sets: unset values, including empty reasoning lists saved by older settings, keep the discovered ones. Clearing the gateway settings restores the instance's original authentication configuration. Existing threads may need a new session to use changed connection settings.

Managed Codex preserves the speed tiers reported by its model catalog and forwards the
selected tier, including Fast, to app-server. Catalog entries are not proof of entitlement;
the upstream service can reject a tier for a particular account or connection. Cox does not
silently retry with a different tier.
Account-catalog speed options fill gaps in native model discovery without discarding
native model settings. Cox does not advertise Fast when neither catalog reports it.

## Development

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

Cox is intended for loopback access only. Do not expose it to an untrusted network. Local authentication and origin checks remain necessary because agent access includes filesystem and terminal operations.

## Checks

```sh
pnpm test
pnpm typecheck
pnpm build
```

Package tests can also be run with `pnpm exec vp test run <test-file>`.

The full server suite (`pnpm --filter cox test`) additionally needs a C compiler for native-launcher fixtures and Playwright Chromium with its platform libraries for headless browser tests. Install the browser with `pnpm --filter cox exec playwright-core install chromium`; these are test prerequisites, not desktop-client components.

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
