# Changelog

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
