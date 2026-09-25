// In-process recall index: incremental BM25 over memory entries with a light
// recency prior. No external services, no native deps — recall is sub-millisecond
// for tens of thousands of entries, and the markdown files stay the human-readable
// source of truth.

import type { MemoryEntry } from './types';

const STOP = new Set(
  'a an and are as at be by for from has have i in is it its of on or that the this to was were will with we you our they them then than so but not do does did can'.split(
    ' '
  )
);

export function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (raw.length < 2 || STOP.has(raw)) continue;
    out.push(stem(raw));
  }
  return out;
}

// Tiny suffix stripper — cheap, deterministic, good enough for recall.
function stem(w: string): string {
  if (w.length > 5 && w.endsWith('ing')) return w.slice(0, -3);
  if (w.length > 4 && w.endsWith('ed')) return w.slice(0, -2);
  if (w.length > 4 && w.endsWith('es')) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1);
  return w;
}

interface Doc {
  entry: MemoryEntry;
  len: number;
  tf: Map<string, number>;
}

export interface RecallHit {
  entry: MemoryEntry;
  score: number;
}

export interface RecallOptions {
  agent?: string;
  /** Include shared (hive-wide) memories along with the agent's private ones. */
  includeShared?: boolean;
  limit?: number;
}

export class MemoryIndex {
  private docs = new Map<string, Doc>();
  private postings = new Map<string, Set<string>>();
  private totalLen = 0;
  private readonly k1 = 1.2;
  private readonly b = 0.75;

  get size(): number {
    return this.docs.size;
  }

  add(entry: MemoryEntry): void {
    if (this.docs.has(entry.id)) this.remove(entry.id);
    const toks = tokenize(`${entry.text} ${entry.tags.join(' ')}`);
    const tf = new Map<string, number>();
    for (const t of toks) tf.set(t, (tf.get(t) ?? 0) + 1);
    this.docs.set(entry.id, { entry, len: toks.length, tf });
    this.totalLen += toks.length;
    for (const t of tf.keys()) {
      let p = this.postings.get(t);
      if (!p) this.postings.set(t, (p = new Set()));
      p.add(entry.id);
    }
  }

  remove(id: string): void {
    const d = this.docs.get(id);
    if (!d) return;
    this.docs.delete(id);
    this.totalLen -= d.len;
    for (const t of d.tf.keys()) {
      const p = this.postings.get(t);
      p?.delete(id);
      if (p && p.size === 0) this.postings.delete(t);
    }
  }

  all(filter?: (e: MemoryEntry) => boolean): MemoryEntry[] {
    const out: MemoryEntry[] = [];
    for (const d of this.docs.values()) if (!filter || filter(d.entry)) out.push(d.entry);
    return out.sort((a, b) => b.createdAt - a.createdAt);
  }

  recall(query: string, opts: RecallOptions = {}): RecallHit[] {
    const { agent, includeShared = true, limit = 8 } = opts;
    const qt = [...new Set(tokenize(query))];
    const allowed = (e: MemoryEntry) =>
      !agent || e.agent === agent || (includeShared && e.scope === 'shared');
    if (qt.length === 0) {
      return this.all(allowed)
        .slice(0, limit)
        .map((entry) => ({ entry, score: 0 }));
    }
    const N = this.docs.size || 1;
    const avg = this.totalLen / N || 1;
    const scores = new Map<string, number>();
    for (const t of qt) {
      const p = this.postings.get(t);
      if (!p) continue;
      const idf = Math.log(1 + (N - p.size + 0.5) / (p.size + 0.5));
      for (const id of p) {
        const d = this.docs.get(id)!;
        if (!allowed(d.entry)) continue;
        const f = d.tf.get(t)!;
        const s = (idf * (f * (this.k1 + 1))) / (f + this.k1 * (1 - this.b + (this.b * d.len) / avg));
        scores.set(id, (scores.get(id) ?? 0) + s);
      }
    }
    const now = Date.now();
    const hits: RecallHit[] = [];
    for (const [id, s] of scores) {
      const e = this.docs.get(id)!.entry;
      // Recency prior: memories decay to ~80% weight over ~30 days, never to zero.
      const ageDays = (now - e.createdAt) / 86_400_000;
      hits.push({ entry: e, score: s * (0.8 + 0.2 * Math.exp(-ageDays / 30)) });
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, limit);
  }
}

/** Render an agent's memories as markdown (the file agents and humans read). */
export function renderMemoryMarkdown(agentName: string, entries: MemoryEntry[]): string {
  const lines = [`# Memory — ${agentName}`, '', '_Managed by Hivefloor. Add with `hive remember "..."`._', ''];
  for (const e of [...entries].sort((a, b) => a.createdAt - b.createdAt)) {
    const d = new Date(e.createdAt).toISOString().slice(0, 16).replace('T', ' ');
    const tags = e.tags.length ? ` ${e.tags.map((t) => `#${t}`).join(' ')}` : '';
    lines.push(`- ${d}${e.scope === 'shared' ? ' [shared]' : ''} ${e.text.replace(/\n/g, ' ')}${tags}`);
  }
  return lines.join('\n') + '\n';
}
