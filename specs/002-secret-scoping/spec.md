# 002 — Per-agent secret scoping

**Status:** Implemented · **Date:** 2026-09-25 · Resolves 001 T16

## Problem
Every agent process received **every** stored API key. It also inherited every
variable in the app's environment, including tokens the user exported in their shell
(`GITHUB_TOKEN`, `AWS_SECRET_ACCESS_KEY`…). One prompt-injected agent, or a simple
`env` in its terminal, could leak all of them.

## User stories
- As the operator, I want the Claude Code agent to get my Anthropic key and nothing
  else, so a leak from it can't expose my OpenAI or cloud credentials.
- As the operator, I want to give one DevOps agent my `GITHUB_TOKEN` without giving
  it to every agent.

## Requirements
- **SR-1** An agent's environment contains a stored secret only if (a) its provider
  declares that key in `keyEnv`, or (b) the secret is listed in the agent's
  `secrets` allowlist. The built-in agent receives `HIVE_LLM_API_KEY` via its launch
  env as before.
- **SR-2** Inherited variables whose names look like credentials (`*KEY*`, `*TOKEN*`,
  `*SECRET*`, `*PASSWORD*`, `*PASSWD*`, `*CREDENTIAL*`, `*_PAT`, `AWS_*`, `AZURE_*`,
  `GOOGLE_APPLICATION_CREDENTIALS`, `KUBECONFIG`, `NPM_TOKEN`…) are removed unless
  they fall under SR-1 (a) or (b). Stored secrets win over inherited values.
- **SR-3** Harness variables (`HIVE_URL`, `HIVE_TOKEN`, …) are always set by the
  harness and can't be shadowed by secrets or inherited vars.
- **FR-1** Settings can store custom-named keys, not only the four presets.
- **FR-2** Hire and Setup forms show which keys the engine gets automatically, and let
  the operator tick extra stored keys for that agent.
- **FR-3** Existing agents keep working: an agent with no `secrets` field gets only
  its provider's keys. `custom` and `shell` agents get no stored keys unless ticked.

## Acceptance criteria
- [x] Unit test: a `claude` agent sees `ANTHROPIC_API_KEY` but not `OPENAI_API_KEY`
      or an inherited `GITHUB_TOKEN`. Ticking `GITHUB_TOKEN` passes it through (SR-1, SR-2)
- [x] Unit test: a secret named `HIVE_TOKEN` or an inherited one can't override the
      harness value (SR-3)
- [x] Non-credential inherited variables (`PATH`, `HOME`, `LANG`…) still pass (FR-3)

## Out of scope
Per-child-process scoping of `HIVE_TOKEN`. Encrypting keys in agent memory. Hiding a
key from the agent that legitimately holds it.
