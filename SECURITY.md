# Security

## Reporting a vulnerability
Please don't open a public issue. Use GitHub's **Report a vulnerability** (private
advisory) on this repository. We aim to acknowledge reports within 3 business days.

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
  an owner-only `settings.json`. They are passed to agent processes as environment
  variables and are never written to the hive log, memory or messages.

## Known limitations
- The approval policy matches text and is **advisory**. The built-in agent enforces it.
  Third-party CLIs (Claude Code, Codex, Gemini, Aider, OpenCode) keep their own
  permission systems and only follow the hive policy by instruction. Configure those
  CLIs' own permission modes as well.
- An agent can run anything its OS user can. Run Hivefloor under a dedicated user,
  or in a VM or container, for untrusted repositories.
- Every stored secret is currently visible to every agent process.
- On Linux without a keyring, keys are stored unencrypted (a warning is logged).

## Data that leaves your machine
Only what your chosen agents send to their model providers (for example Anthropic,
OpenAI or Google), using your keys. Hivefloor itself sends no telemetry.
