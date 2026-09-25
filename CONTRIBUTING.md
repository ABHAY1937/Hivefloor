# Contributing

Thanks for helping! A few rules keep the project healthy and its licensing clean.

## Process
1. Non-trivial changes start as a spec. See [specs/README.md](specs/README.md) and the
   [constitution](specs/constitution.md).
2. `npm run check` must pass (typecheck, tests, evals, dependency audit).
3. Changes to `src/core/policy.ts` add eval cases to `evals/policy/cases.json` first.
4. Security issues go to a private advisory, not a public issue (see [SECURITY.md](SECURITY.md)).

## Licensing of contributions (DCO)
Hivefloor is MIT-licensed. By contributing you agree your contribution is licensed
under the same MIT License ("inbound = outbound"). Every commit must be signed off
under the [Developer Certificate of Origin](https://developercertificate.org/):

```
git commit -s -m "your message"
```

This adds `Signed-off-by: Your Name <you@example.com>`, which certifies that you wrote
the change or otherwise have the right to submit it under the project license. Don't
submit code copied from projects with incompatible licenses (for example GPL code, or
code whose license you don't know).
