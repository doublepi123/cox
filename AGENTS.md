# Cox

Cox is a local-only Web UI for coding agents, derived from T3 Code.

## Scope

- Keep the browser UI, local Node server, agent providers, projects, threads, terminals, Git and checkpoints.
- The desktop client may embed the existing browser UI and a loopback-only local backend for macOS and Windows. It may install and check the official Cox npm package, staging owned-backend upgrades for the next launch with matching data backups and rollback. Client-only packages must bootstrap Cox on first launch. User-controlled desktop-client updates may use official releases, with explicit consent before quitting or replacing the application. Do not add mobile apps, cloud accounts, T3 Connect, relay/tunnel infrastructure, remote environment linking or standalone desktop-update services.
- Bind the server to loopback by default. Nonloopback numeric listen addresses require COX_AUTH_PASSWORD; a password never broadens the bind automatically. Preserve local authentication and WebSocket origin checks.
- Without a password, only local browsers may establish sessions automatically. Never expose local-no-password mode through a proxy; require a password and HTTPS for nonlocal access.
- Cox state belongs in `~/.cox` or a checkout-local `.cox` directory, never `~/.t3`.
- Do not change the original T3 Code checkout or the live T3 installation.

## Code

- Keep orchestration pure; run I/O through services and provider adapters.
- Keep wire contracts in `packages/contracts` and browser state in `packages/client-runtime`.
- Preserve existing formatting and strict TypeScript; avoid `any` and unnecessary abstractions.
- Do not add inline comments unless requested.
- Use `apply_patch` for source changes.
- Never edit live application data, start paid agent turns, or kill processes by name.
- Run focused tests, package typechecks and production builds for changed behavior.
- Do not commit, push, create GitHub repositories or open pull requests unless asked.

## Development

- Node 26 and pnpm are required; see `package.json` for exact versions.
- `pnpm install` installs workspace dependencies.
- `pnpm dev` runs the local API and browser development server.
- `pnpm build` builds the browser and local server.
- `pnpm start` serves the built browser from the local server.
- Keep development data isolated and do not seed from another application's database.

The MIT license and upstream attribution must remain intact.
