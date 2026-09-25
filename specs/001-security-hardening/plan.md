# 001 — Security hardening: plan

## Approach
Harden at the trust boundaries instead of adding new layers. There are three boundaries:
the renderer→main IPC, the agent→harness RPC, and the agent→OS tools of the built-in
agent. Each one validates its input and authorizes against the authenticated identity.
Classifier quality is made measurable with an eval set, so future rule changes are
data-driven.

## Changes
| Area | Files | Change |
|---|---|---|
| deps | `package.json` | electron 33→44, electron-builder 25→26, electron-vite 2→5, vite 5→7, plugin-react 4→5. `allowScripts` pins which packages may run install scripts |
| IPC | `src/main/index.ts` | sender-frame check, `Object.hasOwn` method lookup, field allowlist for hire/updateAgent, validation of llm/policy/secrets, `openPath` removed, sandbox on, navigation/window/permission deny, 0600/0700 modes |
| CSP | `src/renderer/index.html` | + `object-src/frame-src/base-uri/form-action 'none'` |
| RPC server | `src/core/server.ts` | Host check, byte-accurate body limit, params type check |
| RPC authz | `src/core/harness.ts` | SR-6, SR-7 |
| policy | `src/core/policy.ts` | SR-9 rules, amount parsing |
| built-in agent | `resources/agents/llm-agent.cjs` | realpath + `path.relative` containment |
| demo agent | `resources/agents/sim-agent.cjs` | drops the redundant `waiting` status call (the harness sets it) |
| Windows | `src/core/pty.ts` | `resolveCommand()` via PATH/PATHEXT |
| packaging | `electron-builder.yml` | `electronFuses` |
| evals | `evals/policy/cases.json`, `scripts/eval-policy.ts` | labelled set + scorer |
| CI | `.github/workflows/ci.yml`, `.github/dependabot.yml` | 3-OS `npm run check`, weekly dependency PRs |

## Constitution check
- I Local-first: no new network calls.
- II Human approves risk: approvals are now also scoped by kind (SR-7), which is stricter.
- III Agents semi-trusted: SR-6 closes the gaps where the caller's identity was ignored.
- IV Renderer untrusted: SR-2 and SR-3.
- V Secrets: SR-3 secret-name rules, SR-4 file modes.
- VI Performance: the Host check and body buffering are O(1) per request. Policy rules
  grew from 16 to 21 regexes, still µs per classify. No hot path touched.
- VII Proven: `test/security.test.ts` and `npm run eval`.
- VIII Cross-platform: FR-2 fixes Windows; CI matrix.

## Risks and rollback
- The Electron major upgrade can change Chromium/Node behaviour. Mitigation: the e2e
  demo passed on 44.4.5. Rollback means reverting `package.json` and the lockfile.
- Fuses are applied only at package time and are untested in this change (tracked open item).
- Stricter RPCs can break third-party agents that relied on closing others' tasks or on
  `board.set`. The errors are explicit, and the messages point to the allowed alternative.
