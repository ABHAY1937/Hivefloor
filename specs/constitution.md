# Hivefloor Constitution

Principles every spec and plan must satisfy. Changing one of these needs its own spec.

## I. Local-first, user-owned
All state lives on the user's machine (`~/.hivefloor`). No telemetry, accounts or cloud
services are required to run. Anything that sends data off the machine is opt-in and
listed in `SECURITY.md`.

## II. The human approves risk — nobody else
Spend, deletes, big/irreversible changes and external communication require a human
decision. Agents can request approval; only the UI can grant it. An approval is scoped
to the agent it was granted to and to the kind of risk approved. Weakening this needs
a spec with a threat analysis.

## III. Agents are semi-trusted
Assume any agent can be prompt-injected. Every RPC authorizes against the
authenticated caller (bearer token → agent id), never against payload fields. Agents
get the least data and authority their role needs.

## IV. The renderer is untrusted
The main process validates every IPC argument as if it came from the internet.
Context isolation and the sandbox stay on; the renderer never gets Node, `shell`, or
arbitrary file paths.

## V. Secrets stay secret
Keys are encrypted with the OS keychain at rest, never written to the hive log,
memory, board or messages, and only injected into agent process environments.

## VI. Performance budgets are requirements
The numbers in `BENCHMARKS.md` (message delivery p50, WAL append, IPC sends/frame,
recall latency) are regression gates. A plan that touches a hot path states its
expected effect on them.

## VII. Proven, not claimed
Every requirement maps to a test, an eval case, or a written manual check. Every
classification decision (e.g. `ApprovalPolicy`) has a labelled eval set in `evals/`;
a new false negative found in the field becomes an eval case before it is fixed.

## VIII. Cross-platform by default
macOS, Windows and Linux are all first-class. CI runs on all three.
