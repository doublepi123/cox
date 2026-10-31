# Cox server

Local Node.js HTTP/WebSocket server for the Cox browser UI. It manages local agent
processes, projects, terminals and authenticated same-origin connections.

Build from the workspace root with `pnpm build`, then run `pnpm start`. The server
binds to loopback port 4773 by default and stores production data in `~/.cox`.
Use `--home-dir` for isolated state and `--no-browser` for terminal-only startup.

It does not expose cloud, relay, remote-device or application-update services.
See the workspace README for setup and the test prerequisites.
