# 002 — Per-agent secret scoping: plan

## Approach
Move environment construction into one pure function, `buildAgentEnv()` in
`src/core/env.ts`. It takes the inherited environment, the stored secrets, an
allowlist (provider `keyEnv` ∪ `spec.secrets`), the provider's launch env and the
harness variables, and applies the rules in the order they're listed. Pure means
unit-testable, and the sandbox (003) reuses it.

## Changes
| Area | Files | Change |
|---|---|---|
| core | `src/core/env.ts` | `buildAgentEnv`, `looksLikeCredential` |
| core | `src/core/harness.ts` | `startAgent` uses `buildAgentEnv`, and `hire` accepts `secrets` |
| types | `src/core/types.ts` | `AgentSpec.secrets?: string[]` |
| IPC | `src/main/index.ts` | `secrets` field validated as env-safe names |
| UI | `Modals.tsx`, `AgentPanel.tsx` | custom keys in Settings, and an `AgentKeys` picker in Hire and Setup |

## Constitution check
- III Agents semi-trusted: least privilege for credentials.
- V Secrets: tighter. Values are only ever in the target process's env.
- VI Performance: one pass over the env per agent start. No hot path.
- VII Proven: `test/security.test.ts` (2 tests).
- Compatibility: agents with no `secrets` get only their engine's keys. That's a
  deliberate behaviour change, so an agent that relied on a key it wasn't declared
  to need must now have it ticked.
