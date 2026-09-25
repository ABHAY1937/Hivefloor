# 001 — Security hardening & policy evals

**Status:** Implemented (see open items in [tasks.md](tasks.md)) · **Date:** 2026-09-25

## Problem
A security review of v0.1.0 found issues in four places. Dependencies had 17 known
advisories (1 critical, 14 high), including the bundled Electron runtime. The IPC and
agent-RPC surfaces were missing authorization checks. The llm-agent had a
path-containment bug. The approval classifier let common destructive commands through.
There was also no automated way to measure that classifier.

## Threat model
| Actor | Can | Must not be able to |
|---|---|---|
| Human operator (UI) | everything | — |
| Renderer content (if XSS'd) | call the whitelisted API | run arbitrary commands, read/open arbitrary files, navigate to remote pages |
| Worker agent (maybe prompt-injected) | its own mail, tasks, memory, leases; request approvals | impersonate agents, approve anything, close others' tasks, reuse others' approvals, widen an approval's scope, fake "waiting on human", wipe the plan |
| Boss agent | route work, attach approvals it was granted | grant approvals |
| Local web page in a browser | — | reach the control server (DNS rebinding) |
| Other OS users | — | read settings/keys |

Out of scope: a malicious process running as the same OS user (it can read agent env
vars and `~/.hivefloor` directly), and agents executing commands outside the harness.
Claude Code, Codex and the other CLIs run with their own permission systems. The
Hivefloor policy is advisory for them (see *Known limitations*).

## Requirements
- **SR-1** No high/critical advisories in `npm audit`. Electron is on a supported major.
- **SR-2** The renderer runs sandboxed with context isolation. IPC calls from any frame
  other than our own top-level window are rejected. Navigation, new windows and
  permission requests are denied.
- **SR-3** Every IPC argument is validated. Agent edits are limited to an allowlist of
  fields. LLM base URLs must be http(s). Secret names must be env-safe and cannot
  override `HIVE_*`, `PATH`, `NODE_OPTIONS`, `ELECTRON_*`, `LD_*` or `DYLD_*`.
  `openPath` is removed.
- **SR-4** `settings.json` is written 0600 and `~/.hivefloor` is created 0700 (POSIX).
  A warning is logged when the keychain is unavailable and keys are stored raw.
- **SR-5** The control server rejects requests whose `Host` isn't `127.0.0.1:<port>` or
  `localhost:<port>`. It also rejects non-object params, and it counts the body limit
  in bytes.
- **SR-6** Only the assignee, creator or boss may `task.done`. Only the boss may
  `board.set`. Agents may set only `working|idle|blocked`, or `waiting` while they
  have a pending approval. `approval` reads are limited to the requester and the
  boss. `ask` kinds are validated. Lease TTL is clamped to 10 s–4 h.
- **SR-7** A task's pre-approval clears `hive check` only for a verdict of the same
  kind as the approval (or an approval of kind `other`).
- **SR-8** The llm-agent's file tools resolve real paths and refuse anything outside
  the working directory, including siblings that share a prefix and symlink escapes.
- **SR-9** The approval policy catches recursive `rm` in any flag spelling, `rd /s`,
  `find -delete/-exec rm`, `git push +ref`, `filter-repo`, and cloud/cluster deletes
  (`kubectl delete`, `terraform destroy`, `helm uninstall`, `docker … prune`,
  `aws s3 rm`, `gcloud/az … delete`). It flags `terraform apply`, `pulumi up` and
  `gh release create` as big changes. Dollar amounts with thousands separators are
  parsed correctly.
- **SR-10** Electron fuses are set at package time: NODE_OPTIONS off, inspect flags off,
  ASAR integrity on, load-from-ASAR-only on, cookie encryption on. `runAsNode` stays
  on because agents need it.
- **FR-1** `npm run eval` scores the classifier against a labelled set
  (`evals/policy/cases.json`). It reports precision and recall per kind, plus recall
  on risky actions. It exits non-zero on any regression.
- **FR-2** On Windows, bare agent commands (`bash`, `claude` → `claude.cmd`) resolve
  via PATH/PATHEXT before spawning in ConPTY.
- **FR-3** `npm run check` = typecheck + tests + evals + audit. CI runs it on macOS,
  Windows and Linux.

## Acceptance criteria
- [x] `npm audit`: 0 vulnerabilities (SR-1)
- [x] `test/security.test.ts` covers SR-5, SR-6, SR-7, SR-8 and FR-2
- [x] `npm run eval`: 100% on scored cases. The original policy scores 16 regressions on the same set (SR-9, FR-1)
- [x] The real Electron app still runs the full demo flow (`scripts/e2e-demo.cjs`) with no page errors (SR-2, SR-3)
- [x] All 14 original tests pass on Windows. Previously 3 failed and the run hung (FR-2)
- [ ] A packaged build is verified on each OS with fuses applied (SR-10), see tasks.md

## Known limitations (documented, not fixed)
- The approval policy is **text matching**. It can't see through quoting tricks
  (`r''m`), encoded payloads, or deletes done inside a language runtime. These cases
  sit in the eval set as `known_gap`. The built-in agent enforces the policy. Other CLIs
  only follow it by instruction. Real containment needs OS-level sandboxing (open item).
- Every agent receives every stored secret as an env var (open item: scope per provider).
- `HIVE_TOKEN` lives in the agent's environment, so any process that agent spawns can
  act as that agent.
