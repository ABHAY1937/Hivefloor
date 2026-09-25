// Approval policy: decides which agent actions need a human. Deterministic rules
// run first (fast, predictable, auditable); agents can also escalate explicitly
// with `hive ask`. Everything else the boss handles on its own.

import type { ApprovalKind } from './types';

export interface PolicyVerdict {
  needsApproval: boolean;
  kind: ApprovalKind;
  reason: string;
}

export interface PolicyConfig {
  /** File count above which a change counts as "big". */
  bigChangeFiles: number;
  /** Any spend at or above this many dollars needs approval (0 = all spend). */
  spendThresholdUsd: number;
  /** Extra regex patterns (strings) that always require approval. */
  alwaysAsk: string[];
  /** Regex patterns that never require approval (checked first). */
  neverAsk: string[];
}

export const DEFAULT_POLICY: PolicyConfig = {
  bigChangeFiles: 25,
  spendThresholdUsd: 0,
  alwaysAsk: [],
  neverAsk: []
};

interface Rule {
  kind: ApprovalKind;
  re: RegExp;
  reason: string;
}

const RULES: Rule[] = [
  // Destructive operations
  { kind: 'delete', re: /\brm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\b/i, reason: 'recursive force delete' },
  { kind: 'delete', re: /\b(rmdir|rimraf|del\s+\/[sq]|remove-item\b.*-recurse)/i, reason: 'directory removal' },
  { kind: 'delete', re: /\b(drop\s+(table|database|schema)|truncate\s+table)\b/i, reason: 'destructive SQL' },
  { kind: 'delete', re: /\bdelete\s+from\s+\w+\s*(;|$)/i, reason: 'unscoped SQL delete' },
  { kind: 'delete', re: /\bgit\s+(push\s+.*(--force|-f)\b|reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D)/i, reason: 'history-destroying git op' },
  { kind: 'delete', re: /\b(mkfs|format\s+[a-z]:|dd\s+if=)/i, reason: 'disk-level operation' },
  { kind: 'delete', re: /\b(delete|destroy|wipe|purge)\b.{0,40}\b(prod|production|bucket|database|repo|cluster|all)\b/i, reason: 'deleting a shared resource' },
  // Spend
  { kind: 'spend', re: /\$\s?\d|\b\d+(\.\d+)?\s?(usd|dollars|eur|aed)\b/i, reason: 'mentions money' },
  { kind: 'spend', re: /\b(purchase|buy|subscribe|upgrade\s+(the\s+)?plan|billing|credit\s+card|invoice|pay\s+for)\b/i, reason: 'spending money' },
  { kind: 'spend', re: /\b(provision|scale\s+up|launch)\b.{0,30}\b(gpu|instance|cluster|vm|node)s?\b/i, reason: 'provisioning paid infrastructure' },
  // Big changes
  { kind: 'big-change', re: /\b(npm|pnpm|yarn|cargo|twine|gem)\s+publish\b/i, reason: 'publishing a package' },
  { kind: 'big-change', re: /\bgit\s+push\b.*\b(main|master|release)\b/i, reason: 'pushing to a protected branch' },
  { kind: 'big-change', re: /\b(deploy|release)\b.{0,20}\b(prod|production|live)\b/i, reason: 'production deploy' },
  { kind: 'big-change', re: /\b(rewrite|re-architect|migrate)\b.{0,30}\b(entire|whole|all|codebase|database|schema)\b/i, reason: 'large-scale rewrite or migration' },
  { kind: 'big-change', re: /\b(change|swap|replace)\b.{0,20}\b(framework|architecture|database engine)\b/i, reason: 'architecture change' },
  // External side effects
  { kind: 'external', re: /\b(send|post)\b.{0,20}\b(email|tweet|slack message|to customers?|newsletter)\b/i, reason: 'external communication' }
];

export class ApprovalPolicy {
  constructor(private cfg: PolicyConfig = DEFAULT_POLICY) {}

  update(cfg: Partial<PolicyConfig>): void {
    this.cfg = { ...this.cfg, ...cfg };
  }

  get config(): PolicyConfig {
    return this.cfg;
  }

  /** Classify free text (a shell command, a plan, a message body). */
  classify(text: string, meta: { filesTouched?: number } = {}): PolicyVerdict {
    for (const p of this.cfg.neverAsk) {
      if (safeRe(p)?.test(text)) return { needsApproval: false, kind: 'other', reason: 'allow-listed' };
    }
    for (const p of this.cfg.alwaysAsk) {
      if (safeRe(p)?.test(text)) return { needsApproval: true, kind: 'other', reason: `matches rule /${p}/` };
    }
    if ((meta.filesTouched ?? 0) >= this.cfg.bigChangeFiles) {
      return { needsApproval: true, kind: 'big-change', reason: `touches ${meta.filesTouched} files` };
    }
    for (const r of RULES) {
      if (!r.re.test(text)) continue;
      if (r.kind === 'spend' && this.cfg.spendThresholdUsd > 0) {
        const amt = maxDollarAmount(text);
        if (amt !== null && amt < this.cfg.spendThresholdUsd) continue;
      }
      return { needsApproval: true, kind: r.kind, reason: r.reason };
    }
    return { needsApproval: false, kind: 'other', reason: 'routine' };
  }
}

function maxDollarAmount(text: string): number | null {
  const m = [...text.matchAll(/\$\s?(\d+(?:[.,]\d+)?)|(\d+(?:\.\d+)?)\s?(?:usd|dollars)/gi)];
  if (m.length === 0) return null;
  return Math.max(...m.map((x) => parseFloat((x[1] ?? x[2]).replace(',', ''))));
}

const reCache = new Map<string, RegExp | null>();
function safeRe(p: string): RegExp | null {
  if (!reCache.has(p)) {
    try {
      reCache.set(p, new RegExp(p, 'i'));
    } catch {
      reCache.set(p, null);
    }
  }
  return reCache.get(p)!;
}
