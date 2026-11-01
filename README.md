# Cox

Cox is a local Web interface for coding agents, derived from [T3 Code](https://github.com/pingdotgg/t3code), starting at `0102f07afb` in the `doublepi123/t3code` fork.

Run the server on your computer and control your locally installed coding agents from a browser. Your projects, conversation history, credentials and checkpoints stay in your local Cox data directory.

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
Technical diagnostics, external provider messages and some advanced settings retain English;
see the [localization notes](apps/web/src/i18n/README.md) for coverage and contribution guidance.

## Requirements

- Node.js `26.12.1` and pnpm `12.14.0`.
- Git and at least one supported agent CLI installed and authenticated locally (for example Codex or Claude Code).
- A C/C++ build toolchain may be needed if a native dependency has no prebuilt binary for your platform.

## Development

```sh
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5733`. Follow the local authentication flow printed by the server. The development server proxies API and WebSocket requests to `127.0.0.1:4773`; do not set `VITE_HTTP_URL` or `VITE_WS_URL`.

Development state is isolated in this checkout's `.cox/`. It does not read or seed from `~/.t3`. Use `COX_SERVER_PORT` and `COX_WEB_PORT` in your environment or `.env` to change ports. `pnpm dev:server` and `pnpm dev:web` run either half separately.

## Production

For npm releases, install the public scoped package and run its `cox` command:

```sh
npm install --global @doublepi123/cox
cox
```

The npm package includes the built Web UI and server. npm installs the runtime dependencies;
pnpm and a source checkout are not required. Allow install scripts so Cox can preserve its
runtime dependency patches. Native dependencies may need a local C/C++ build toolchain.

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
