// Eval for the approval classifier (ApprovalPolicy.classify): the one place the
// harness makes an automatic "does a human need to see this?" decision.
//
//   npm run eval            # human-readable report, exit 1 on any regression
//   npm run eval -- --json  # machine-readable, for CI dashboards
//
// A miss on a risky case (false negative) is the costly error: it lets an agent
// act without approval. A false positive costs the human a click. Both fail the
// run, except cases marked known_gap, which document the limits of regex rules.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ApprovalPolicy } from '../src/core/policy';
import type { ApprovalKind } from '../src/core/types';

interface Case {
  text: string;
  expect: ApprovalKind | null;
  known_gap?: boolean;
  note?: string;
}

const { cases } = JSON.parse(readFileSync(join(__dirname, '../evals/policy/cases.json'), 'utf8')) as { cases: Case[] };
const policy = new ApprovalPolicy();
const KINDS: (ApprovalKind | 'routine')[] = ['delete', 'spend', 'big-change', 'external', 'routine'];

const rows = cases.map((c) => {
  const v = policy.classify(c.text);
  const got = v.needsApproval ? v.kind : null;
  return { ...c, got, reason: v.reason, pass: got === c.expect };
});

const scored = rows.filter((r) => !r.known_gap);
const label = (k: ApprovalKind | null) => k ?? 'routine';
const perKind = KINDS.map((k) => {
  const tp = scored.filter((r) => label(r.expect) === k && label(r.got) === k).length;
  const fp = scored.filter((r) => label(r.expect) !== k && label(r.got) === k).length;
  const fn = scored.filter((r) => label(r.expect) === k && label(r.got) !== k).length;
  const precision = tp + fp ? tp / (tp + fp) : 1;
  const recall = tp + fn ? tp / (tp + fn) : 1;
  return { kind: k, support: tp + fn, precision, recall };
});
const failures = scored.filter((r) => !r.pass);
const risky = scored.filter((r) => r.expect !== null);
const missedRisky = risky.filter((r) => r.got === null).length;
const summary = {
  cases: rows.length,
  scored: scored.length,
  accuracy: (scored.length - failures.length) / scored.length,
  riskyRecall: (risky.length - missedRisky) / risky.length,
  perKind,
  failures: failures.map(({ text, expect, got, reason }) => ({ text, expect, got, reason })),
  knownGaps: rows.filter((r) => r.known_gap).map(({ text, expect, got, pass, note }) => ({ text, expect, got, nowCaught: pass, note }))
};

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  const pct = (n: number) => `${(n * 100).toFixed(1)}%`.padStart(7);
  console.log(`\nApproval policy eval — ${summary.scored} scored cases (+${summary.knownGaps.length} known gaps)\n`);
  console.log('kind         support  precision  recall');
  for (const k of perKind) console.log(`${k.kind.padEnd(12)} ${String(k.support).padStart(7)}  ${pct(k.precision)}    ${pct(k.recall)}`);
  console.log(`\naccuracy ${pct(summary.accuracy)} · risky-action recall ${pct(summary.riskyRecall)} (misses let an agent act unapproved)`);
  if (failures.length) {
    console.log(`\n✖ ${failures.length} regression(s):`);
    for (const f of summary.failures) console.log(`  expected ${label(f.expect).padEnd(10)} got ${label(f.got).padEnd(10)} ${JSON.stringify(f.text)}  (${f.reason})`);
  } else console.log('\n✔ no regressions');
  console.log('\nknown gaps (documented limits of text rules — see specs/001-security-hardening/spec.md):');
  for (const g of summary.knownGaps) console.log(`  ${g.nowCaught ? '✔ now caught' : '·'} ${JSON.stringify(g.text)} — ${g.note}`);
}
process.exitCode = failures.length ? 1 : 0;
