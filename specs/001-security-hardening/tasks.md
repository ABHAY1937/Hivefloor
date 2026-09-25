# 001 — Security hardening: tasks

## Done
- [x] T1 (SR-1) upgrade Electron + build toolchain; `npm audit` → 0
- [x] T2 (SR-2) sandbox, sender-frame check, deny navigation/windows/permissions
- [x] T3 (SR-3) IPC argument validation; remove `openPath`
- [x] T4 (SR-4) 0600 settings / 0700 home; plaintext-key warning
- [x] T5 (SR-5) control server Host check, params check, byte limit
- [x] T6 (SR-6, SR-7) RPC authorization rules + `test/security.test.ts`
- [x] T7 (SR-8) llm-agent path containment + test
- [x] T8 (SR-9, FR-1) policy rules + `evals/policy/cases.json` + `npm run eval`
- [x] T9 (FR-2) Windows command resolution; all 14 original tests pass on Windows
- [x] T10 (SR-10) `electronFuses` in electron-builder.yml
- [x] T11 (FR-3) `npm run check`, CI on 3 OSes, Dependabot
- [x] T12 docs: SECURITY.md, specs/

## Open — needed before selling or shipping to customers
- [ ] T13 (SR-10) build installers on each OS (`npm run dist:*`) and confirm the app
      and agents start with fuses applied
- [ ] T14 **Code signing**: Apple Developer ID + notarization (macOS), an EV/OV
      code-signing certificate (Windows). Unsigned apps trigger Gatekeeper and
      SmartScreen warnings, and enterprises block them
- [ ] T15 **Auto-update** (electron-updater) over HTTPS with signed artifacts, so
      security fixes actually reach users
- [x] T16 **Secret scoping** → done in [002](../002-secret-scoping/spec.md): inject only the provider's `keyEnv` keys (plus keys the user
      explicitly assigns to that agent) instead of every stored secret
- [x] T17 **Agent containment** → Docker sandbox in [003](../003-agent-sandbox/spec.md); OS-native option still open there: optional per-agent OS sandbox (container / Windows
      Sandbox / macOS sandbox-exec, or a restricted user) so a prompt-injected agent
      can't reach the rest of the machine. The regex policy is not a sandbox
- [ ] T18 Short-lived, per-session tokens: rotate `HIVE_TOKEN` on restart (already the
      case), and consider per-child-process scoping
- [ ] T19 Rate limit / quota on agent RPCs (memory and message flooding by a runaway agent)
- [x] T20 License and ownership → proprietary, © 2026 Abhay, all rights reserved (internal use). LICENSE + THIRD_PARTY_NOTICES.md + CONTRIBUTING.md (written agreement for contributors). Was: `package.json` says MIT but there is no LICENSE file.
      Decide the license (MIT/Apache-2.0/commercial) before a company ships it, and
      confirm the rights to code inspired by munder-difflin
- [ ] T21 Privacy policy and data-handling statement (what goes to model providers)
- [ ] T22 Opt-in crash reporting (no content, no keys)
- [ ] T23 Grow the eval set from real usage. Every false negative becomes a case first
- [ ] T24 `npm run bench` segfaults on Windows in the PTY stage (10 concurrent node-pty
      ConPTY sessions, native crash in node-pty 1.1.0). It doesn't involve harness code
      (it spawns an absolute path), and the 5-agent demo runs fine. Reproduce on
      node-pty's latest version and report upstream
