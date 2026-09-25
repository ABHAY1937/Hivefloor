# Spec-Driven Development

Every non-trivial change to Hivefloor starts as a written spec, not as code. The
spec is the source of truth; code, tests and evals are how we prove we met it.

```
constitution.md  →  NNN-feature/spec.md  →  plan.md  →  tasks.md  →  code + tests + evals  →  npm run check
   (rules that        (WHAT and WHY,         (HOW:        (ordered,      (each task links     (the gate)
    never change       no implementation)     design,      checkable      back to a
    per feature)                              risks)       steps)         requirement ID)
```

## The loop

1. **Specify** — copy `templates/spec.md` to `specs/NNN-short-name/spec.md` (next free number).
   Write user stories, numbered requirements (`FR-1`, `SR-1` for security, `PR-1` for
   performance) and acceptance criteria. No file names or function names yet.
2. **Clarify** — list open questions in the spec under *Open questions*. A spec with open
   questions that affect requirements is not ready for planning.
3. **Plan** — `templates/plan.md` → `plan.md`. Architecture, files touched, data/IPC
   changes, a **Constitution check** (one line per principle), and risks.
4. **Tasks** — `templates/tasks.md` → `tasks.md`. Small, ordered, each tagged with the
   requirement it satisfies. Tests and eval cases are tasks, not afterthoughts.
5. **Implement** — work task by task; tick them off in the same commit as the code.
6. **Verify** — `npm run check` (typecheck + tests + evals + dependency audit) must be
   green. Acceptance criteria in the spec are checked off by hand where not automated.

Small fixes (typo, one-line bug with a test) can skip the spec — say so in the commit.

## Working with AI agents

The spec files are written to be handed to an agent — including Hivefloor's own boss agent:
`hive task new "Implement specs/004-x tasks 1–3" --spec "$(cat specs/004-x/tasks.md)"`.
Agents must cite requirement IDs in commits and must not widen scope beyond `tasks.md`.

## Index

| # | Spec | Status |
|---|---|---|
| 001 | [Security hardening & policy evals](001-security-hardening/spec.md) | Implemented (open items in tasks.md) |
