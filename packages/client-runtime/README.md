# Cox client runtime

Shared browser runtime for the co-hosted Cox server. The browser uses the page origin for authenticated HTTP and WebSocket connections; provider authentication remains managed by the local server.

This package owns local connection supervision, RPC transport, cookie-authenticated HTTP requests, browser preview streaming, and reactive project, thread, terminal, Git, checkpoint, provider and settings state. It does not discover or connect to remote environments, relay services, cloud accounts, native applications or mobile devices.

Applications should import the narrowest relevant subpath, such as `state/shell`, `state/threads`, `state/terminal` or `state/vcs`. Exported subpaths are public API boundaries; other files are implementation details.
