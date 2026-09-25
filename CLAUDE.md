# Working on Hivefloor

- Spec-driven: read `specs/constitution.md` first. Non-trivial changes need
  `specs/NNN-name/{spec,plan,tasks}.md` from `specs/templates/` before code. Cite
  requirement IDs (FR-/SR-/PR-) in commits, and tick `tasks.md` in the same commit.
- The gate is `npm run check`: typecheck, tests, `npm run eval` and a dependency audit.
- Changing `src/core/policy.ts`: add eval cases to `evals/policy/cases.json` first
  (a failing case, then the fix). Never delete a case to make the eval pass.
- Trust boundaries (see SECURITY.md): renderer→main IPC (`src/main/index.ts`) and
  agent→harness RPC (`src/core/harness.ts` `rpc()`). Validate every input and
  authorize against the authenticated caller, never against payload fields.
- Hot paths have budgets in BENCHMARKS.md. Run `npm run bench` when touching
  hive/pty/server/memory.
