# Contributing to Cox

Cox is a local-only browser interface for coding agents. Read `AGENTS.md` for scope and safety constraints, and `README.md` for installation and commands.

Keep changes focused. Add behavior tests for authentication, provider protocol translation, orchestration, persistence and command execution. Run focused tests and the affected package typechecks before submitting changes. Do not reintroduce desktop/mobile clients, cloud accounts, relays, tunnels or remote machine linking.

Never use an existing T3 installation's data directory for development or tests.
