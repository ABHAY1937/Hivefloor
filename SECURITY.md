
# Security

## Reporting a vulnerability

Hivefloor is internal software. Report vulnerabilities privately to the owner
(GitHub: @ABHAY1937), not in an issue or a shared channel.

## Security model (summary)

The full threat model and requirements are in
[specs/001-security-hardening/spec.md](specs/001-security-hardening/spec.md).

- **Renderer**: sandboxed, context-isolated, strict CSP. Only our own top-level window
  can call the main process, and every argument is validated.
- **Agents** are treated as semi-trusted, because they may be prompt-injected. Each
  agent authenticates with its own bearer token to a loopback-only control server.
  That server rejects foreign `Host` headers, which blocks DNS rebinding. Agents
  cannot impersonate each other, grant approvals, reuse another agent's approval, or
  stretch an approval to a different kind of risk.
- **Approvals**: spend, deletes, big changes and external communication go to the
  human. The classifier is measured by `npm run eval`.
- **Secrets** are encrypted with the OS keychain (Electron `safeStorage`) and stored in
  an owner-only `settings.json`. They are never written to the hive log, memory or
  messages. Each agent receives only its engine's own keys plus the keys you tick for
  it. Credential-looking variables from the app's environment (`*_TOKEN`, `AWS_*`, …)
  are stripped ([spec 002](specs/002-secret-scoping/spec.md)).
- **Sandbox**: with *Sandbox → Docker container*, an agent runs in a container that
  sees only its working folder. It has all capabilities dropped, no privilege
  escalation, a non-root user, memory/CPU/process limits and a private home. Secret
  values never appear on a command line ([spec 003](specs/003-agent-sandbox/spec.md)).

## Known limitations

- The approval policy matches text and is **advisory**. The built-in agent enforces it.
  Third-party CLIs (Claude Code, Codex, Gemini, Aider, OpenCode) keep their own
  permission systems and only follow the hive policy by instruction. Configure those
  CLIs' own permission modes as well, and use the Docker sandbox for untrusted code.
- Without the sandbox, an agent can run anything its OS user can.
- Sandboxed agents still have outbound internet (they need their model APIs), and they
  can modify the folder they are given. Use worktree isolation and git for that.
- An agent can read the keys it was given. Grant each key to as few agents as possible.
- On Linux without a keyring, keys are stored unencrypted (a warning is logged).

## Data that leaves your machine

Only what your chosen agents send to their model providers (for example Anthropic,
OpenAI or Google), using your keys. Hivefloor itself sends no telemetry.
