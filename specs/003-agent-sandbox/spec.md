# 003 — Agent sandbox (Docker containers)

**Status:** Implemented · **Date:** 2026-09-25 · Resolves 001 T17

## Problem
Agents run as the operator's OS user, so a prompt-injected agent can read the
operator's `~/.ssh`, browser profiles and cloud credentials, delete files outside the
project, or install malware. The approval policy is text matching (see 001's known
gaps) and only the built-in agent enforces it. Hivefloor needs containment that works
even when an agent ignores its instructions.

## User stories
- As the operator, I want to run an agent on an untrusted repo in a container that can
  only see that repo, so a malicious README can't steal my SSH keys.
- As the operator, I want sandboxed agents to keep working normally: `hive` CLI, memory,
  messages, approvals, their CLI logins, and my local Ollama.

## Requirements
- **SR-1** An agent with `sandbox: 'docker'` runs inside a container that sees only its
  working folder (read-write), the bundled agent scripts (read-only), its identity
  folder (read-only) and a private per-agent home folder. It sees nothing else from
  the host filesystem.
- **SR-2** Containers run with all Linux capabilities dropped, `no-new-privileges`, a
  PID limit, memory and CPU limits, `--init`, as a non-root user, and with `--rm`.
- **SR-3** Secret values never appear on the `docker` command line (visible in `ps`).
  They pass by name (`-e NAME`) from the docker client's environment. The
  container gets the same scoped set as 002 and none of the host's inherited
  environment.
- **SR-4** Image names are validated so they can't inject docker flags (`--privileged`).
- **SR-5** Containers are labelled and force-removed when the agent stops, when the
  harness shuts down, and at the next start (for containers left by a crash).
- **FR-1** Agents in containers reach the control server: Docker Desktop (macOS,
  Windows) via `host.docker.internal`; Linux via the bridge gateway (the server also
  listens there, still token-protected, `host-gateway` alias). The built-in agent's
  `localhost` model URLs are rewritten to `host.docker.internal`.
- **FR-2** A default image (`resources/sandbox/Dockerfile`: Node 24, git, bash,
  python3, ripgrep, Claude Code / Codex / Gemini CLIs) is built on first use. A
  custom image can be set per agent.
- **FR-3** CLI logins persist per agent in `~/.hivefloor/sandbox/<id>/home`, never in
  the host home.
- **FR-4** On POSIX hosts the working folder is mounted at the same path, so git
  worktrees (whose `.git` files point at absolute host paths) keep working. In
  worktree mode the main repo is mounted too. On Windows it's mounted at `/work`.
- **FR-5** The Hire and Setup forms offer *Sandbox: none | Docker* and an image field.
  A failure to start (Docker missing, build failed) shows on the agent as an error
  with the reason.

## Acceptance criteria
- [x] Unit tests: docker args contain the limits and mounts, no secret values, the
      rewritten URLs, and reject a flag-shaped image (SR-2, SR-3, SR-4, FR-1)
- [x] Integration test (runs where Docker is available, including Linux CI): a
      containerised agent completes a `hive` round-trip, cannot see an ungranted
      secret, and its container is gone after stop (SR-1, SR-3, SR-5, FR-1)
- [ ] Manual: Claude Code agent in the default image on macOS, Windows and Linux

## Known limitations
- Network egress is not restricted: agents need their model APIs. An allowlist egress
  proxy is future work.
- Requires Docker Desktop or Docker Engine. Rootless Docker and Podman on Linux may need a
  different gateway address.
- Sandboxing protects the host, not the project: an agent can still damage the
  folder it is given. Use worktree isolation + git for that.
