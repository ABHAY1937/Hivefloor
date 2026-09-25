# Contributing

Hivefloor is proprietary, internal software (see [LICENSE](LICENSE)). Only people
the owner has authorised in writing may contribute.

## Before you contribute
- You need a signed agreement with the owner. It confirms that everything you write
  for Hivefloor is assigned to the owner, and it keeps the code confidential.
- Don't paste in code from other projects unless its license allows proprietary use
  (MIT, BSD, Apache-2.0, ISC are fine). Never copy GPL/AGPL code or code whose
  license you don't know. Record new third-party code in
  [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Commit with the identity the owner gave you, not an employer's email.

## Process
1. Non-trivial changes start as a spec. See [specs/README.md](specs/README.md) and the
   [constitution](specs/constitution.md).
2. `npm run check` must pass (typecheck, tests, evals, dependency audit).
3. Changes to `src/core/policy.ts` add eval cases to `evals/policy/cases.json` first.
4. Report security issues to the owner privately (see [SECURITY.md](SECURITY.md)).
