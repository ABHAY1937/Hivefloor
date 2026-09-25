# 003 — Agent sandbox: tasks

- [x] T1 (SR-2, SR-3, SR-4, FR-4) `buildDockerLaunch` + unit tests
- [x] T2 (FR-1) server `allowHost` / `listenAlso`; URL rewriting for local models
- [x] T3 (SR-1, FR-3) harness launch path, container shim, per-agent home
- [x] T4 (SR-5) cleanup on exit, on shutdown, and at start (crash leftovers)
- [x] T5 (FR-2) default Dockerfile, built on first use; shipped in installers
- [x] T6 (FR-5) Sandbox field in Hire / Setup; start errors shown on the agent
- [x] T7 integration test (exact mount list, secret hidden, round-trip, cleanup): passes on Windows + Docker Desktop
- [x] T8 CI: Linux builds the image and runs the integration test
- [ ] T9 manual: Claude Code in the default image on macOS, Windows, Linux (log in once per agent)
- [ ] T10 egress allowlist (proxy container) so a sandboxed agent can only reach its model API
- [ ] T11 lighter OS-native sandbox for users without Docker (bubblewrap / sandbox-exec / AppContainer)
- [ ] T12 user docs: Docker Desktop licensing and free alternatives, the Linux ufw rule
