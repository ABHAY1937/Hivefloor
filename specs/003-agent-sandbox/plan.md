# 003 — Agent sandbox: plan

## Approach
Keep the PTY model: the PTY runs the `docker` client with `run -it`, so the terminal,
flow control, idle detection and nudges work unchanged. All docker argument building
is one pure function (`buildDockerLaunch`), so the security properties are
unit-testable without Docker.

Alternatives considered:
- **OS-native sandboxes** (macOS `sandbox-exec`, Linux bubblewrap/landlock, Windows
  AppContainer): three different implementations, and `sandbox-exec` is deprecated.
  They may come later as a lighter option.
- **A VM per agent**: strongest isolation, but too heavy for a desktop app.
- **A restricted OS user**: needs admin rights to create and differs per OS.

Docker works the same on all three OSes and is already installed by most of our
users (developers).

## Changes
| Area | Files | Change |
|---|---|---|
| core | `src/core/sandbox.ts` | `buildDockerLaunch`, `validImage`, `hostUrl`, image build, bridge gateway lookup, container cleanup |
| core | `src/core/harness.ts` | `launchAgent` splits into host vs sandbox paths. `prepareSandbox`, container tracking and cleanup, start errors shown on the agent |
| server | `src/core/server.ts` | `allowHost`, `listenAlso` (Linux bridge gateway) |
| types | `src/core/types.ts` | `sandbox`, `sandboxImage` |
| IPC | `src/main/index.ts` | validation (image refs can't be flags) |
| UI | `Modals.tsx`, `AgentPanel.tsx` | `SandboxField` |
| image | `resources/sandbox/Dockerfile` | Node 24 + git/bash/python/rg + agent CLIs. Non-root. Shipped via `extraResources` |
| CI | `.github/workflows/ci.yml` | Linux job builds the image (no CLIs) and runs the Docker integration test |

## Container layout
| Container path | Host source | Mode |
|---|---|---|
| workdir (same path on POSIX, `/work` on Windows) | agent working folder | rw |
| `/hive/agents` | bundled agent scripts | ro |
| `/hive/agent` | `~/.hivefloor/hive/agents/<id>` (identity, claude settings) | ro |
| `/hive/bin` | `~/.hivefloor/sandbox/bin` (`hive` shim) | ro |
| `/hive/home` | `~/.hivefloor/sandbox/<id>/home` (CLI logins) | rw |

## Constitution check
- I Local-first: everything runs locally. The image is built locally from our Dockerfile.
- III Agents semi-trusted: now enforced by the kernel rather than by instructions.
- V Secrets: values never appear in argv. Only scoped secrets are forwarded.
- VI Performance: container start adds ~0.5–1 s per agent start. Nothing changes on
  the hot paths. Terminal output goes through the docker client, which costs a little
  latency for sandboxed agents only.
- VII Proven: `test/sandbox.test.ts`, with 3 unit tests and 1 Docker integration test,
  which checks the exact mount list.
- VIII Cross-platform: verified on Windows + Docker Desktop and on Linux CI.
  macOS + Docker Desktop still needs a manual check.

## Risks
- Docker Desktop licensing: it's free for personal use, education and small
  businesses, but larger companies need a paid Docker subscription. Docker Engine on
  Linux, Colima and Rancher Desktop are free alternatives. This goes in the user docs.
- Linux firewalls (ufw) can block the docker0 → host port. The fix goes in the docs.
