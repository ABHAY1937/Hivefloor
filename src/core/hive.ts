// The hive: an event-sourced, in-memory store with an append-only write-ahead log.
//
// Why not "a git repo of JSON files committed on every message" (the reference
// design)? Because synchronous `git add -A && git commit` on the main thread costs
// tens to hundreds of milliseconds per message and serialises every agent behind
// index.lock. Here every mutation is:
//   1. applied to memory (O(1)),
//   2. appended to events.jsonl through one buffered stream (async, batched),
//   3. emitted to listeners (router, UI) in the same tick.
// A snapshot is written on a debounce so startup is snapshot + short tail replay.
// Messages are delivered in-process — no polling interval, no outbox scanning.

import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, statSync, renameSync, type WriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { Bus } from './bus';
import { MemoryIndex, renderMemoryMarkdown } from './memory';
import { ApprovalPolicy } from './policy';
import {
  BOSS_ALIAS,
  BROADCAST,
  HUMAN,
  type AgentSpec,
  type Approval,
  type ApprovalKind,
  type HiveEvent,
  type HiveMessage,
  type HiveSnapshot,
  type Lease,
  type MemoryEntry,
  type SequencedEvent,
  type SpeechAct,
  type Task,
  type TaskStatus
} from './types';
import { debounce, newId, throttle, writeAtomic, writeAtomicSync } from './util';

export const HOP_CAP = 8;
const WAL_ROTATE_BYTES = 32 * 1024 * 1024;
const MAX_MESSAGES_IN_MEMORY = 20_000;

export interface HiveEvents extends Record<string, unknown> {
  event: SequencedEvent;
  delivered: { msg: HiveMessage; recipients: string[] };
  approval: Approval;
  leases: Lease[];
}

export interface SendInput {
  from: string;
  to: string;
  subject: string;
  body?: string;
  act?: SpeechAct;
  replyTo?: string | null;
  conv?: string;
}

export class Hive {
  readonly bus = new Bus<HiveEvents>();
  readonly memory = new MemoryIndex();
  readonly policy = new ApprovalPolicy();

  private seq = 0;
  private agents = new Map<string, AgentSpec>();
  private messages: HiveMessage[] = [];
  private msgById = new Map<string, HiveMessage>();
  private inboxes = new Map<string, Set<string>>(); // agent -> unread msg ids
  private tasks = new Map<string, Task>();
  private approvals = new Map<string, Approval>();
  private board = '';
  private leases = new Map<string, Lease>();
  private wal: WriteStream | null = null;
  private walBytes = 0;
  private waiters = new Map<string, Set<() => void>>();
  private dirtyMemoryFiles = new Set<string>();
  // Snapshots are O(state), so they're throttled; the WAL makes every event durable in between.
  private readonly scheduleSnapshot = throttle(() => void this.writeSnapshot(), 5000);
  private readonly scheduleMemoryFiles = debounce(() => void this.flushMemoryFiles(), 300);
  private leaseTimer: NodeJS.Timeout | null = null;

  constructor(readonly root: string) {}

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async open(): Promise<void> {
    mkdirSync(join(this.root, 'agents'), { recursive: true });
    const snapPath = join(this.root, 'state.json');
    if (existsSync(snapPath)) {
      try {
        this.loadSnapshot(JSON.parse(readFileSync(snapPath, 'utf8')) as HiveSnapshot);
      } catch (e) {
        console.warn('[hive] snapshot unreadable, rebuilding from log', e);
      }
    }
    await this.replayWal();
    const walPath = join(this.root, 'events.jsonl');
    this.walBytes = existsSync(walPath) ? statSync(walPath).size : 0;
    this.wal = createWriteStream(walPath, { flags: 'a' });
    this.leaseTimer = setInterval(() => this.expireLeases(), 5_000);
    this.leaseTimer.unref?.();
  }

  async close(): Promise<void> {
    if (this.leaseTimer) clearInterval(this.leaseTimer);
    this.scheduleSnapshot.cancel();
    this.scheduleMemoryFiles.cancel();
    this.flushMemoryFilesSync();
    writeAtomicSync(join(this.root, 'state.json'), JSON.stringify(this.snapshot()));
    await new Promise<void>((r) => (this.wal ? this.wal.end(r) : r()));
    this.wal = null;
  }

  private async replayWal(): Promise<void> {
    const walPath = join(this.root, 'events.jsonl');
    if (!existsSync(walPath)) return;
    const rl = createInterface({ input: createReadStream(walPath, 'utf8'), crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line) continue;
      try {
        const se = JSON.parse(line) as SequencedEvent;
        if (se.seq > this.seq) {
          this.apply(se.ev);
          this.seq = se.seq;
        }
      } catch {
        /* torn final line after a crash — ignore */
      }
    }
  }

  private loadSnapshot(s: HiveSnapshot): void {
    this.seq = s.seq;
    for (const a of Object.values(s.agents)) this.agents.set(a.id, a);
    for (const m of s.messages) this.indexMessage(m);
    for (const t of Object.values(s.tasks)) this.tasks.set(t.id, t);
    for (const a of Object.values(s.approvals)) this.approvals.set(a.id, a);
    for (const e of s.memory) this.memory.add(e);
    this.board = s.board ?? '';
  }

  snapshot(): HiveSnapshot {
    return {
      seq: this.seq,
      agents: Object.fromEntries(this.agents),
      messages: this.messages,
      tasks: Object.fromEntries(this.tasks),
      approvals: Object.fromEntries(this.approvals),
      memory: this.memory.all(),
      board: this.board
    };
  }

  private async writeSnapshot(): Promise<void> {
    await writeAtomic(join(this.root, 'state.json'), JSON.stringify(this.snapshot()));
    if (this.walBytes > WAL_ROTATE_BYTES && this.wal) {
      // Snapshot is durable, so the log can be rotated to an archive.
      const walPath = join(this.root, 'events.jsonl');
      const old = this.wal;
      this.wal = null;
      await new Promise<void>((r) => old.end(r));
      renameSync(walPath, join(this.root, `events-${Date.now()}.jsonl`));
      this.wal = createWriteStream(walPath, { flags: 'a' });
      this.walBytes = 0;
    }
  }

  // ─── the single mutation path ─────────────────────────────────────────────

  private commit(ev: HiveEvent): SequencedEvent {
    const se: SequencedEvent = { seq: ++this.seq, at: Date.now(), ev };
    this.apply(ev);
    const line = JSON.stringify(se) + '\n';
    this.walBytes += line.length;
    this.wal?.write(line);
    this.scheduleSnapshot();
    this.bus.emit('event', se);
    return se;
  }

  private apply(ev: HiveEvent): void {
    switch (ev.t) {
      case 'agent.add':
        this.agents.set(ev.spec.id, ev.spec);
        break;
      case 'agent.update': {
        const a = this.agents.get(ev.id);
        if (a) this.agents.set(ev.id, { ...a, ...ev.patch, id: a.id });
        break;
      }
      case 'agent.remove':
        this.agents.delete(ev.id);
        this.inboxes.delete(ev.id);
        break;
      case 'msg.send':
        this.indexMessage(ev.msg);
        break;
      case 'msg.read':
        for (const id of ev.ids) {
          const m = this.msgById.get(id);
          if (m && !m.readAt) m.readAt = ev.at;
          this.inboxes.get(ev.agent)?.delete(id);
        }
        break;
      case 'task.put':
        this.tasks.set(ev.task.id, ev.task);
        break;
      case 'approval.put':
        this.approvals.set(ev.approval.id, ev.approval);
        break;
      case 'memory.add':
        this.memory.add(ev.entry);
        this.dirtyMemoryFiles.add(ev.entry.agent);
        break;
      case 'memory.remove':
        this.memory.remove(ev.id);
        break;
      case 'board.set':
        this.board = ev.text;
        break;
    }
  }

  private indexMessage(m: HiveMessage): void {
    if (this.msgById.has(m.id)) return;
    this.messages.push(m);
    this.msgById.set(m.id, m);
    if (!m.readAt) {
      for (const r of this.recipientsOf(m)) {
        let s = this.inboxes.get(r);
        if (!s) this.inboxes.set(r, (s = new Set()));
        s.add(m.id);
      }
    }
    if (this.messages.length > MAX_MESSAGES_IN_MEMORY) {
      const drop = this.messages.splice(0, this.messages.length - MAX_MESSAGES_IN_MEMORY);
      for (const d of drop) this.msgById.delete(d.id);
    }
  }

  private recipientsOf(m: HiveMessage): string[] {
    if (m.to === BROADCAST) return [...this.agents.keys()].filter((id) => id !== m.from);
    return [m.to];
  }

  // ─── agents ───────────────────────────────────────────────────────────────

  listAgents(): AgentSpec[] {
    return [...this.agents.values()].sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.createdAt - b.createdAt);
  }
  getAgent(id: string): AgentSpec | undefined {
    return this.agents.get(id);
  }
  boss(): AgentSpec | undefined {
    for (const a of this.agents.values()) if (a.isBoss) return a;
    return undefined;
  }
  addAgent(spec: AgentSpec): AgentSpec {
    if (this.agents.has(spec.id)) throw new Error(`agent ${spec.id} already exists`);
    if (spec.isBoss && this.boss()) throw new Error('there is already a boss agent');
    this.commit({ t: 'agent.add', spec });
    this.dirtyMemoryFiles.add(spec.id);
    this.scheduleMemoryFiles();
    return spec;
  }
  updateAgent(id: string, patch: Partial<AgentSpec>): void {
    if (!this.agents.has(id)) throw new Error(`no agent ${id}`);
    this.commit({ t: 'agent.update', id, patch });
  }
  removeAgent(id: string): void {
    this.releaseLeases(id);
    this.commit({ t: 'agent.remove', id });
  }
  agentDir(id: string): string {
    return join(this.root, 'agents', id);
  }

  /** Resolve aliases ("boss", names, ids) to an agent id. */
  resolve(target: string): string | null {
    if (target === HUMAN || target === BROADCAST) return target;
    if (target === BOSS_ALIAS) return this.boss()?.id ?? null;
    if (this.agents.has(target)) return target;
    const t = target.toLowerCase();
    for (const a of this.agents.values()) if (a.name.toLowerCase() === t) return a.id;
    return null;
  }

  // ─── messaging / router ───────────────────────────────────────────────────

  /**
   * Route a message. Guarantees:
   *  - sender is authoritative (callers pass the authenticated agent id);
   *  - hop cap kills ping-pong loops by escalating to the boss;
   *  - "human" traffic goes to the boss (the human's proxy) unless it is an
   *    approval, which goes to the approvals queue;
   *  - delivery is synchronous and wakes long-pollers immediately.
   */
  send(input: SendInput): HiveMessage {
    const parent = input.replyTo ? this.msgById.get(input.replyTo) : undefined;
    let to = this.resolve(input.to);
    if (!to) throw new Error(`unknown recipient "${input.to}"`);
    const hops = parent ? parent.hops + 1 : 0;
    let subject = input.subject;
    if (hops > HOP_CAP) {
      const boss = this.boss();
      if (boss && to !== boss.id && input.from !== boss.id) {
        to = boss.id;
        subject = `[loop-cap] ${subject}`;
      }
    }
    // Agents talking to "human" reach the boss, who decides whether to escalate.
    if (to === HUMAN && input.from !== this.boss()?.id && this.boss()) to = this.boss()!.id;

    const msg: HiveMessage = {
      id: newId('m'),
      conv: input.conv ?? parent?.conv ?? newId('c'),
      replyTo: input.replyTo ?? null,
      from: input.from,
      to,
      act: input.act ?? (parent ? 'inform' : 'request'),
      subject: subject.slice(0, 200),
      body: input.body ?? '',
      hops,
      createdAt: Date.now()
    };
    this.commit({ t: 'msg.send', msg });
    const recipients = this.recipientsOf(msg);
    this.bus.emit('delivered', { msg, recipients });
    for (const r of recipients) this.wake(r);
    return msg;
  }

  inbox(agent: string, opts: { all?: boolean; markRead?: boolean; limit?: number } = {}): HiveMessage[] {
    const { all = false, markRead = false, limit = 50 } = opts;
    let list: HiveMessage[];
    if (all) {
      list = this.messages.filter((m) => m.to === agent || m.from === agent || (m.to === BROADCAST && m.from !== agent)).slice(-limit);
    } else {
      const ids = this.inboxes.get(agent);
      list = ids ? [...ids].map((id) => this.msgById.get(id)!).filter(Boolean).slice(0, limit) : [];
    }
    if (markRead) {
      const unread = list.filter((m) => this.inboxes.get(agent)?.has(m.id)).map((m) => m.id);
      if (unread.length) this.commit({ t: 'msg.read', agent, ids: unread, at: Date.now() });
    }
    return list;
  }

  unreadCount(agent: string): number {
    return this.inboxes.get(agent)?.size ?? 0;
  }

  getMessage(id: string): HiveMessage | undefined {
    return this.msgById.get(id);
  }

  recentMessages(limit = 200): HiveMessage[] {
    return this.messages.slice(-limit);
  }

  /** Long-poll: resolves as soon as the agent has unread mail, or after timeout. */
  waitForMail(agent: string, timeoutMs: number): Promise<boolean> {
    if (this.unreadCount(agent) > 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let set = this.waiters.get(agent);
      if (!set) this.waiters.set(agent, (set = new Set()));
      const done = () => {
        clearTimeout(timer);
        set!.delete(done);
        resolve(this.unreadCount(agent) > 0);
      };
      const timer = setTimeout(done, timeoutMs);
      timer.unref?.();
      set.add(done);
    });
  }

  private wake(agent: string): void {
    const set = this.waiters.get(agent);
    if (set) for (const fn of [...set]) fn();
  }

  // ─── tasks ────────────────────────────────────────────────────────────────

  createTask(t: { title: string; spec?: string; assignee?: string | null; createdBy: string; approval?: string }): Task {
    const now = Date.now();
    const assignee = t.assignee ? this.resolve(t.assignee) : null;
    const task: Task = {
      id: newId('t'),
      title: t.title.slice(0, 200),
      spec: t.spec ?? '',
      assignee,
      createdBy: t.createdBy,
      status: assignee ? 'active' : 'queued',
      ...(t.approval ? { approval: t.approval } : {}),
      createdAt: now,
      updatedAt: now
    };
    this.commit({ t: 'task.put', task });
    return task;
  }

  updateTask(id: string, patch: { status?: TaskStatus; result?: string; assignee?: string | null }): Task {
    const cur = this.tasks.get(id);
    if (!cur) throw new Error(`no task ${id}`);
    const task: Task = { ...cur, ...patch, updatedAt: Date.now() };
    this.commit({ t: 'task.put', task });
    return task;
  }

  /** Atomic claim of a queued task (single-threaded event loop = no races). */
  claimTask(id: string, agent: string): Task {
    const cur = this.tasks.get(id);
    if (!cur) throw new Error(`no task ${id}`);
    if (cur.assignee && cur.assignee !== agent) throw new Error(`task ${id} already claimed by ${cur.assignee}`);
    return this.updateTask(id, { assignee: agent, status: 'active' });
  }

  listTasks(): Task[] {
    return [...this.tasks.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  // ─── approvals (human-in-the-loop) ────────────────────────────────────────

  requestApproval(agent: string, kind: ApprovalKind, summary: string, detail = ''): Approval {
    // De-duplicate: identical pending request from the same agent is returned as-is.
    for (const a of this.approvals.values()) {
      if (a.status === 'pending' && a.agent === agent && a.summary === summary) return a;
    }
    const approval: Approval = { id: newId('a'), agent, kind, summary: summary.slice(0, 300), detail, status: 'pending', createdAt: Date.now() };
    this.commit({ t: 'approval.put', approval });
    this.bus.emit('approval', approval);
    return approval;
  }

  decide(id: string, approved: boolean, reason = ''): Approval {
    const cur = this.approvals.get(id);
    if (!cur) throw new Error(`no approval ${id}`);
    if (cur.status !== 'pending') return cur;
    const approval: Approval = { ...cur, status: approved ? 'approved' : 'denied', decidedAt: Date.now(), reason };
    this.commit({ t: 'approval.put', approval });
    this.bus.emit('approval', approval);
    // Tell the requesting agent through its normal inbox, so it wakes up.
    if (this.agents.has(cur.agent)) {
      this.send({
        from: HUMAN,
        to: cur.agent,
        act: approved ? 'agree' : 'refuse',
        subject: `${approved ? 'APPROVED' : 'DENIED'}: ${cur.summary}`,
        body: `Approval ${id} was ${approval.status} by the human.${reason ? ` Note: ${reason}` : ''}`
      });
    }
    return approval;
  }

  getApproval(id: string): Approval | undefined {
    return this.approvals.get(id);
  }

  listApprovals(status?: Approval['status']): Approval[] {
    return [...this.approvals.values()].filter((a) => !status || a.status === status).sort((a, b) => b.createdAt - a.createdAt);
  }

  // ─── memory ───────────────────────────────────────────────────────────────

  remember(agent: string, text: string, opts: { shared?: boolean; tags?: string[] } = {}): MemoryEntry {
    const entry: MemoryEntry = {
      id: newId('k'),
      agent,
      scope: opts.shared ? 'shared' : 'private',
      text: text.trim().slice(0, 4000),
      tags: opts.tags ?? [],
      createdAt: Date.now()
    };
    this.commit({ t: 'memory.add', entry });
    this.scheduleMemoryFiles();
    return entry;
  }

  forget(id: string): void {
    this.commit({ t: 'memory.remove', id });
  }

  private memoryFileBody(agent: string): string {
    const spec = this.agents.get(agent);
    return renderMemoryMarkdown(spec?.name ?? agent, this.memory.all((e) => e.agent === agent));
  }

  private async flushMemoryFiles(): Promise<void> {
    const ids = [...this.dirtyMemoryFiles];
    this.dirtyMemoryFiles.clear();
    await Promise.all(ids.map((id) => writeAtomic(join(this.agentDir(id), 'memory.md'), this.memoryFileBody(id))));
  }

  private flushMemoryFilesSync(): void {
    for (const id of this.dirtyMemoryFiles) writeAtomicSync(join(this.agentDir(id), 'memory.md'), this.memoryFileBody(id));
    this.dirtyMemoryFiles.clear();
  }

  // ─── blackboard ───────────────────────────────────────────────────────────

  getBoard(): string {
    return this.board;
  }
  setBoard(text: string, by: string): void {
    this.commit({ t: 'board.set', text: text.slice(0, 200_000), by });
  }
  appendBoard(text: string, by: string): void {
    const who = this.agents.get(by)?.name ?? by;
    this.setBoard(`${this.board}${this.board ? '\n' : ''}- **${who}**: ${text}`, by);
  }

  // ─── file leases: keep agents from editing the same files at once ─────────

  /**
   * Acquire advisory leases on paths (files or directories). Overlap is by path
   * prefix, so a lease on `src/api` conflicts with `src/api/user.ts`.
   */
  acquireLeases(agent: string, paths: string[], ttlMs = 10 * 60_000): { ok: boolean; conflicts: Lease[] } {
    this.expireLeases();
    const norm = paths.map(normPath);
    const conflicts: Lease[] = [];
    for (const p of norm) {
      for (const l of this.leases.values()) {
        if (l.agent !== agent && overlaps(p, l.path)) conflicts.push(l);
      }
    }
    if (conflicts.length) return { ok: false, conflicts };
    const expiresAt = Date.now() + ttlMs;
    for (const p of norm) this.leases.set(`${agent}\u0000${p}`, { path: p, agent, expiresAt });
    this.bus.emit('leases', this.listLeases());
    return { ok: true, conflicts: [] };
  }

  releaseLeases(agent: string, paths?: string[]): number {
    const norm = paths?.map(normPath);
    let n = 0;
    for (const [k, l] of this.leases) {
      if (l.agent === agent && (!norm || norm.includes(l.path))) {
        this.leases.delete(k);
        n++;
      }
    }
    if (n) this.bus.emit('leases', this.listLeases());
    return n;
  }

  listLeases(): Lease[] {
    return [...this.leases.values()];
  }

  private expireLeases(): void {
    const now = Date.now();
    let changed = false;
    for (const [k, l] of this.leases) {
      if (l.expiresAt <= now) {
        this.leases.delete(k);
        changed = true;
      }
    }
    if (changed) this.bus.emit('leases', this.listLeases());
  }
}

function normPath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
}
function overlaps(a: string, b: string): boolean {
  return a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
}
