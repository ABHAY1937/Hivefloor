# NNN — <Feature name>: plan

## Approach
The design in a few paragraphs. Alternatives considered and why they lost.

## Changes
| Area | Files | Change |
|---|---|---|
| core | `src/core/…` | … |
| IPC / RPC surface | … | new/changed methods, their validation |
| data | `~/.hivefloor/…` | new events, migrations, WAL compatibility |

## Constitution check
- I Local-first: …
- II Human approves risk: …
- III Agents semi-trusted: …
- IV Renderer untrusted: …
- V Secrets: …
- VI Performance: expected effect on BENCHMARKS.md numbers
- VII Proven: which tests / eval cases
- VIII Cross-platform: …

## Risks and rollback
