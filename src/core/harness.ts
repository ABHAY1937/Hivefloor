// Harness: wires the hive (state), the PTY manager (processes), the control server
// (agent API) and the providers together. Pure Node — Electron main is a thin shell
// over this, and the headless demo/tests drive it directly.

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'node:fs';
import { join, delimiter } from 'node:path';
import { promisify } from 'node:util';
import { Bus } from './bus';
import { Hive } from './hive';
import { MemoryIndex } from './memory';
import { getProvider, PROVIDERS, renderIdentity } from './providers';
import { PtyManager, type PtyBatchItem } from './pty';
import { ControlServer } from './server';
import {
  HUMAN,
  type AgentSpec,
  type AgentState,
  type AgentStatus,
  type ApprovalKind,
  type AvatarLook,
  type HiveMessage,
  type LiveSignal,
  type SequencedEvent,
  type Station
} from './types';
import { clip, slug } from './util';

const pexec = promisify(execFile);

export interface HarnessOptions {
  home: string;
  /** Directory with bundled agent scripts (sim-agent.cjs, llm-agent.cjs, hive-cli.cjs). */
  agentsDir: string;
  /** Node-compatible executable. In Electron: process.execPath + ELECTRON_RUN_AS_NODE. */
  nodeBin?: string;
  runAsNode?: boolean;
  /** Extra env (API keys) injected into every agent. Never persisted in the hive. */
  secrets?: Record<string, string>;
  llm?: { baseUrl?: string; apiKey?: string; model?: string; api?: string };
  /** Speed multiplier for the sim agent (demo). */
  simSpeed?: number;
  pty?: ConstructorParameters<typeof PtyManager>[0];
}

export interface HarnessEvents extends Record<string, unknown> {
  hive: SequencedEvent;
  signal: LiveSignal;
  pty: PtyBatchItem[];
  exit: { id: string; exitCode: number | null };
}

const LOOKS: AvatarLook[] = [
  { shirt: '#4F7CAC', hair: '#2B1B12', skin: '#F1C7A5' },
  { shirt: '#C8553D', hair: '#6B3E26', skin: '#E0AC82' },
  { shirt: '#3E8E7E', hair: '#111111', skin: '#8D5B3E' },
  { shirt: '#8E6CB5', hair: '#D9A441', skin: '#F6D3B8' },
  { shirt: '#D98E04', hair: '#3B2A20', skin: '#C68A62' },
  { shirt: '#5C6B73', hair: '#A0522D', skin: '#FAD9C1' },
  { shirt: '#B23A48', hair: '#1C1C1C', skin: '#A86B4C' },
  { shirt: '#2E86AB', hair: '#E8D5B7', skin: '#F3CFB3' }
];

export class Harness {
  readonly bus = new Bus<HarnessEvents>();
  readonly hive: Hive;
  readonly pty: PtyManager;
  readonly server: ControlServer;
  private states = new Map<string, AgentState>();
  private explicitStatusUntil = new Map<string, number>();
  private lastNudge = new Map<string, number>();
  private nudgeTimers = new Map<string, NodeJS.Timeout>();
  private tokens = new Map<string, string>();
  private readonly binDir: string;
  private readonly nodeBin: string;

  constructor(readonly opts: HarnessOptions) {
    this.hive = new Hive(join(opts.home, 'hive'));
    this.pty = new PtyManager(opts.pty);
    this.server = new ControlServer((agent, method, params) => this.rpc(agent, method, params));
    this.binDir = join(opts.home, 'bin');
    this.nodeBin = opts.nodeBin ?? process.execPath;
  }

  // ─── lifecycle ────────────────────────────────────────────────────────────

  async start(): Promise<void> {
    mkdirSync(this.opts.home, { recursive: true });
    await this.hive.open();
    await this.server.listen();
    this.writeShims();
    this.hive.bus.on('event', (se) => this.bus.emit('hive', se));
    this.hive.bus.on('delivered', ({ msg, recipients }) => this.onDelivered(msg, recipients));
    this.hive.bus.on('leases', (leases) => this.bus.emit('signal', { t: 'lease.change', leases }));
    this.hive.bus.on('approval', (a) => {
      if (a.status === 'pending') this.setState(a.agent, { status: 'waiting', station: 'boss-door', note: `waiting for approval: ${clip(a.summary, 60)}` });
    });
    this.pty.bus.on('batch', (b) => this.bus.emit('pty', b));
    this.pty.bus.on('activity', ({ id, active }) => this.onActivity(id, active));
    this.pty.bus.on('exit', ({ id, exitCode }) => {
      this.server.revokeAgent(id);
      this.setState(id, { status: exitCode === 0 ? 'offline' : 'error', station: 'desk', note: `exited (${exitCode})`, exitCode, pid: undefined });
      this.hive.releaseLeases(id);
      this.bus.emit('exit', { id, exitCode });
    });
    for (const a of this.hive.listAgents()) this.states.set(a.id, this.freshState());
  }

  async stop(): Promise<void> {
    this.pty.killAll();
    for (const t of this.nudgeTimers.values()) clearTimeout(t);
    await this.server.close();
    await this.hive.close();
  }

  private writeShims(): void {
    mkdirSync(this.binDir, { recursive: true });
    const cli = join(this.opts.agentsDir, 'hive-cli.cjs');
    const envPrefix = this.opts.runAsNode ? 'ELECTRON_RUN_AS_NODE=1 ' : '';
    const sh = join(this.binDir, 'hive');
    writeFileSync(sh, `#!/bin/sh\n${envPrefix}exec "${this.nodeBin}" "${cli}" "$@"\n`);
    try {
      chmodSync(sh, 0o755);
    } catch {
      /* windows */
    }
    writeFileSync(
      join(this.binDir, 'hive.cmd'),
      `@echo off\r\n${this.opts.runAsNode ? 'set ELECTRON_RUN_AS_NODE=1\r\n' : ''}"${this.nodeBin}" "${cli}" %*\r\n`
    );
    writeFileSync(
      join(this.binDir, 'hive.ps1'),
      `${this.opts.runAsNode ? '$env:ELECTRON_RUN_AS_NODE=1\n' : ''}& "${this.nodeBin}" "${cli}" @args\n`
    );
  }

  // ─── agent management ─────────────────────────────────────────────────────

  hire(input: {
    name: string;
    role: string;
    provider: string;
    skills?: string[];
    model?: string;
    cwd?: string;
    isolation?: 'shared' | 'worktree';
    isBoss?: boolean;
    command?: string;
    args?: string[];
  }): AgentSpec {
    getProvider(input.provider);
    let id = slug(input.name);
    for (let i = 2; this.hive.getAgent(id); i++) id = `${slug(input.name)}-${i}`;
    const n = this.hive.listAgents().length;
    const spec: AgentSpec = {
      id,
      name: input.name,
      role: input.role,
      skills: input.skills ?? [],
      provider: input.provider,
      model: input.model,
      cwd: input.cwd || join(this.opts.home, 'workspace'),
      isolation: input.isolation ?? 'shared',
      isBoss: !!input.isBoss,
      avatar: LOOKS[n % LOOKS.length],
      command: input.command,
      args: input.args,
      createdAt: Date.now()
    };
    this.hive.addAgent(spec);
    this.states.set(id, this.freshState());
    this.bus.emit('signal', { t: 'agent.state', id, state: this.states.get(id)! });
    return spec;
  }

  async fire(id: string): Promise<void> {
    this.pty.kill(id);
    this.hive.removeAgent(id);
    this.states.delete(id);
  }

  state(id: string): AgentState {
    return this.states.get(id) ?? this.freshState();
  }

  allStates(): Record<string, AgentState> {
    return Object.fromEntries(this.states);
  }

  private freshState(): AgentState {
    return { status: 'offline', station: 'desk', note: '', lastActivity: Date.now() };
  }

  private setState(id: string, patch: Partial<AgentState>): void {
    if (!this.hive.getAgent(id)) return;
    const next = { ...this.state(id), ...patch, lastActivity: Date.now() };
    this.states.set(id, next);
    this.bus.emit('signal', { t: 'agent.state', id, state: next });
  }

  async startAgent(id: string, size?: { cols: number; rows: number }): Promise<void> {
    const spec = this.hive.getAgent(id);
    if (!spec) throw new Error(`no agent ${id}`);
    if (this.pty.has(id)) return;
    const provider = getProvider(spec.provider);
    this.setState(id, { status: 'starting', note: 'booting up…', exitCode: undefined });

    mkdirSync(spec.cwd, { recursive: true });
    const workdir = spec.isolation === 'worktree' ? await this.ensureWorktree(spec) : spec.cwd;
    const dir = this.hive.agentDir(id);
    mkdirSync(dir, { recursive: true });
    const prompt = renderIdentity(spec, this.hive.listAgents());
    const identityFile = join(dir, 'identity.md');
    writeFileSync(identityFile, prompt);
    let settingsFile: string | undefined;
    if (provider.stopHook) {
      settingsFile = join(dir, 'claude-settings.json');
      const hook = process.platform === 'win32' ? `"${join(this.binDir, 'hive.cmd')}" hook stop` : `"${join(this.binDir, 'hive')}" hook stop`;
      writeFileSync(settingsFile, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: hook }] }] } }, null, 2));
    }
    const token = randomBytes(24).toString('hex');
    this.tokens.set(id, token);
    this.server.register(token, id);

    const kickoff = spec.isBoss
      ? 'You are now on shift as the boss. Run `hive recall "project"` and `hive inbox`, then wait for the human\'s requests.'
      : 'You are now on shift. Run `hive recall "project"` and `hive inbox` and handle anything waiting. Then wait for tasks.';
    const launch = provider.build({
      spec,
      prompt,
      kickoff,
      identityFile,
      agentsDir: this.opts.agentsDir,
      settingsFile,
      node: this.nodeBin,
      llm: this.opts.llm ?? {}
    });
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(this.opts.secrets ?? {}),
      ...(launch.env ?? {}),
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      FORCE_COLOR: '1',
      HIVE_URL: this.server.url,
      HIVE_TOKEN: token,
      HIVE_AGENT: id,
      HIVE_HOME: this.hive.root,
      HIVE_AGENT_DIR: dir,
      HIVE_SIM_SPEED: String(this.opts.simSpeed ?? 1),
      PATH: `${this.binDir}${delimiter}${process.env.PATH ?? ''}`
    };
    if (this.opts.runAsNode && launch.command === this.nodeBin) env.ELECTRON_RUN_AS_NODE = '1';
    delete env.ELECTRON_NO_ATTACH_CONSOLE;
    const pid = this.pty.spawn({ id, command: launch.command, args: launch.args, cwd: workdir, env, cols: size?.cols, rows: size?.rows });
    this.setState(id, { status: 'idle', station: 'desk', note: 'on shift', pid, workdir });
  }

  stopAgent(id: string): void {
    this.pty.kill(id);
  }

  async restartAgent(id: string): Promise<void> {
    if (this.pty.has(id)) {
      await new Promise<void>((resolve) => {
        const off = this.pty.bus.on('exit', (e) => {
          if (e.id === id) {
            off();
            resolve();
          }
        });
        this.pty.kill(id);
        setTimeout(resolve, 3000);
      });
    }
    await this.startAgent(id);
  }

  /** Give a worker its own git worktree + branch so parallel edits never collide. */
  private async ensureWorktree(spec: AgentSpec): Promise<string> {
    const target = join(this.opts.home, 'worktrees', spec.id);
    if (existsSync(target)) return target;
    try {
      await pexec('git', ['-C', spec.cwd, 'rev-parse', '--is-inside-work-tree']);
      await pexec('git', ['-C', spec.cwd, 'worktree', 'add', '-B', `hive/${spec.id}`, target]);
      return target;
    } catch (e) {
      this.log('warn', `worktree unavailable for ${spec.id} (${(e as Error).message.split('\n')[0]}); using shared folder`, spec.id);
      return spec.cwd;
    }
  }

  // ─── human ↔ boss ─────────────────────────────────────────────────────────

  /** The human talks to the boss. Delivered to the inbox and typed into CLIs. */
  tellBoss(text: string): HiveMessage {
    const boss = this.hive.boss();
    if (!boss) throw new Error('hire a boss first');
    const msg = this.hive.send({ from: HUMAN, to: boss.id, act: 'request', subject: clip(text.split('\n')[0], 120), body: text });
    const p = getProvider(boss.provider);
    if (p.nudge === 'type' && this.pty.has(boss.id)) {
      this.pty.typeLine(boss.id, text);
      this.hive.inbox(boss.id, { markRead: true });
    }
    return msg;
  }

  /** Write raw keystrokes into an agent's terminal (from the UI). */
  input(id: string, data: string): void {
    this.pty.write(id, data);
  }

  // ─── routing suggestions ──────────────────────────────────────────────────

  /** Rank workers for a task by BM25 over role + skills, preferring idle agents. */
  route(task: string): { id: string; name: string; score: number; status: AgentStatus }[] {
    const idx = new MemoryIndex();
    const workers = this.hive.listAgents().filter((a) => !a.isBoss);
    for (const a of workers) idx.add({ id: a.id, agent: a.id, scope: 'shared', text: `${a.role} ${a.name}`, tags: a.skills, createdAt: 0 });
    const hits = new Map(idx.recall(task, { limit: 50 }).map((h) => [h.entry.id, h.score]));
    return workers
      .map((a) => {
        const st = this.state(a.id).status;
        const load = st === 'working' ? 0.85 : st === 'offline' || st === 'error' ? 0.3 : 1;
        return { id: a.id, name: a.name, score: +((hits.get(a.id) ?? 0) * load + (st === 'idle' ? 0.01 : 0)).toFixed(3), status: st };
      })
      .sort((a, b) => b.score - a.score);
  }

  // ─── delivery side effects ────────────────────────────────────────────────

  private onDelivered(msg: HiveMessage, recipients: string[]): void {
    for (const r of recipients) {
      const spec = this.hive.getAgent(r);
      if (!spec || !this.pty.has(r)) continue;
      const p = getProvider(spec.provider);
      if (p.nudge !== 'type') continue;
      if (msg.from === HUMAN && spec.isBoss) continue; // tellBoss already typed it
      this.scheduleNudge(r);
    }
  }

  /** Wake an idle CLI agent by typing a short prompt — debounced and rate-limited. */
  private scheduleNudge(id: string): void {
    if (this.nudgeTimers.has(id)) return;
    const t = setTimeout(() => {
      this.nudgeTimers.delete(id);
      const unread = this.hive.unreadCount(id);
      if (!unread || !this.pty.has(id)) return;
      if (this.pty.isActive(id)) return this.scheduleNudge(id); // busy: try again later
      const last = this.lastNudge.get(id) ?? 0;
      if (Date.now() - last < 15_000) return this.scheduleNudge(id);
      this.lastNudge.set(id, Date.now());
      this.pty.typeLine(id, `[hive] You have ${unread} new message(s). Run \`hive inbox\` and act on them.`);
    }, 1500);
    t.unref?.();
    this.nudgeTimers.set(id, t);
  }

  private onActivity(id: string, active: boolean): void {
    if ((this.explicitStatusUntil.get(id) ?? 0) > Date.now()) return;
    const cur = this.state(id);
    if (cur.status === 'waiting' || cur.status === 'offline' || cur.status === 'error') return;
    this.setState(id, active ? { status: 'working', station: 'desk' } : { status: 'idle', station: 'coffee', note: cur.note });
  }

  private log(level: 'info' | 'warn' | 'error', text: string, agent?: string): void {
    this.bus.emit('signal', { t: 'log', level, text, agent });
  }

  // ─── agent RPC (via control server + hive CLI) ────────────────────────────

  async rpc(agent: string, method: string, p: Record<string, unknown>): Promise<unknown> {
    const s = (k: string) => (p[k] === undefined || p[k] === null ? undefined : String(p[k]));
    const need = (k: string) => {
      const v = s(k);
      if (!v) throw new Error(`missing "${k}"`);
      return v;
    };
    const hive = this.hive;
    switch (method) {
      case 'whoami':
        return { ...hive.getAgent(agent), state: this.state(agent) };
      case 'roster':
        return hive.listAgents().map((a) => ({ id: a.id, name: a.name, role: a.role, skills: a.skills, isBoss: a.isBoss, status: this.state(a.id).status, note: this.state(a.id).note }));
      case 'send': {
        const msg = hive.send({ from: agent, to: need('to'), subject: need('subject'), body: s('body'), act: s('act') as never, replyTo: s('replyTo') ?? null });
        const to = msg.to;
        this.pulse(agent, 'working', `messaging ${hive.getAgent(to)?.name ?? to}`);
        return msg;
      }
      case 'inbox': {
        const wait = Number(p.waitMs ?? 0);
        if (wait > 0 && hive.unreadCount(agent) === 0) await hive.waitForMail(agent, Math.min(wait, 120_000));
        return hive.inbox(agent, { all: !!p.all, markRead: p.peek ? false : true, limit: Number(p.limit ?? 50) });
      }
      case 'read': {
        const m = hive.getMessage(need('id'));
        if (!m || (m.to !== agent && m.from !== agent && m.to !== 'all')) throw new Error('no such message');
        return m;
      }
      case 'remember': {
        const tags = (s('tags') ?? '').split(',').map((t) => t.trim()).filter(Boolean);
        this.pulse(agent, undefined, 'writing to memory', 'archive');
        return hive.remember(agent, need('text'), { shared: !!p.shared, tags });
      }
      case 'recall':
        this.pulse(agent, undefined, 'recalling memories', 'archive');
        return hive.memory.recall(s('query') ?? '', { agent, limit: Number(p.limit ?? 8) }).map((h) => ({ ...h.entry, score: +h.score.toFixed(3) }));
      case 'task.new': {
        // A task can carry a human approval, but only one that was granted to the
        // creating agent — agents can't launder approvals they don't own.
        let approval: string | undefined;
        const apId = s('approval');
        if (apId) {
          const ap = hive.getApproval(apId);
          if (!ap || ap.status !== 'approved' || ap.agent !== agent) throw new Error(`approval ${apId} is not an approval granted to you`);
          approval = apId;
        }
        const task = hive.createTask({ title: need('title'), spec: s('spec'), assignee: s('to') ?? null, createdBy: agent, approval });
        if (task.assignee && task.assignee !== agent) {
          hive.send({ from: agent, to: task.assignee, act: 'request', subject: `Task ${task.id}: ${task.title}`, body: `${task.spec}\n\nWhen finished: hive task done ${task.id} --result "..."` });
        }
        return task;
      }
      case 'task.list':
        return hive.listTasks().filter((t) => !p.mine || t.assignee === agent).slice(0, Number(p.limit ?? 30));
      case 'task.claim':
        return hive.claimTask(need('id'), agent);
      case 'task.done': {
        const t = hive.updateTask(need('id'), { status: p.failed ? 'failed' : 'done', result: s('result') ?? '' });
        const creator = t.createdBy;
        if (creator && creator !== agent && (hive.getAgent(creator) || creator === HUMAN)) {
          hive.send({ from: agent, to: creator, act: 'done', subject: `Done: ${t.title}`, body: t.result ?? '' });
        }
        hive.releaseLeases(agent);
        this.pulse(agent, 'idle', `finished: ${clip(t.title, 50)}`, 'coffee');
        return t;
      }
      case 'status': {
        const st = (s('status') ?? 'working') as AgentStatus;
        const station: Station = st === 'waiting' ? 'boss-door' : st === 'blocked' ? 'whiteboard' : st === 'idle' ? 'coffee' : /test|build|deploy|ci\b/i.test(s('note') ?? '') ? 'server' : 'desk';
        this.explicitStatusUntil.set(agent, Date.now() + 20_000);
        this.setState(agent, { status: st, note: clip(s('note') ?? '', 120), station });
        return this.state(agent);
      }
      case 'board.get':
        return hive.getBoard();
      case 'board.append':
        hive.appendBoard(need('text'), agent);
        this.pulse(agent, undefined, 'updating the plan', 'whiteboard');
        return hive.getBoard();
      case 'board.set':
        hive.setBoard(need('text'), agent);
        return hive.getBoard();
      case 'lease':
        return hive.acquireLeases(agent, (p.paths as string[]) ?? [], Number(p.ttlMs ?? 600_000));
      case 'release':
        return { released: hive.releaseLeases(agent, p.paths as string[] | undefined) };
      case 'leases':
        return hive.listLeases();
      case 'check': {
        const verdict = hive.policy.classify(need('text'), { filesTouched: Number(p.files ?? 0) });
        const task = s('task') ? hive.listTasks().find((t) => t.id === s('task')) : undefined;
        if (verdict.needsApproval && task?.approval && task.assignee === agent && hive.getApproval(task.approval)?.status === 'approved') {
          return { needsApproval: false, kind: verdict.kind, reason: `pre-approved by the human (${task.approval})`, approval: task.approval };
        }
        return verdict;
      }
      case 'ask': {
        const kind = (s('kind') ?? 'other') as ApprovalKind;
        const a = hive.requestApproval(agent, kind, need('summary'), s('detail') ?? '');
        const wait = Number(p.waitMs ?? 0);
        if (wait > 0) {
          const decided = await new Promise<typeof a>((resolve) => {
            const off = hive.bus.on('approval', (x) => {
              if (x.id === a.id && x.status !== 'pending') {
                off();
                clearTimeout(timer);
                resolve(x);
              }
            });
            const timer = setTimeout(() => {
              off();
              resolve(hive.getApproval(a.id)!);
            }, Math.min(wait, 600_000));
            timer.unref?.();
          });
          return decided;
        }
        return a;
      }
      case 'approval':
        return hive.getApproval(need('id'));
      case 'route':
        return this.route(need('task')).slice(0, 5);
      case 'hook.stop': {
        // Claude Code Stop hook: keep the agent working while it has mail.
        if (p.stop_hook_active) return {};
        const unread = hive.inbox(agent, { markRead: true });
        if (!unread.length) return {};
        const lines = unread.map((m) => `- [${m.id}] from ${m.from} (${m.act}): ${m.subject}${m.body ? `\n  ${clip(m.body, 800)}` : ''}`);
        return { decision: 'block', reason: `You have ${unread.length} new hive message(s):\n${lines.join('\n')}\nHandle them, reply with \`hive send\`, then stop.` };
      }
      default:
        throw new Error(`unknown method ${method}`);
    }
  }

  /** Transient visual cue (walk to a station) that doesn't override real status. */
  private pulse(agent: string, status: AgentStatus | undefined, note: string, station?: Station): void {
    const patch: Partial<AgentState> = { note };
    if (status) patch.status = status;
    if (station) patch.station = station;
    this.setState(agent, patch);
  }

  // ─── demo office ──────────────────────────────────────────────────────────

  /** Seed a small office (boss + 4 specialists) if empty. */
  seedOffice(provider = 'sim', cwd?: string): AgentSpec[] {
    if (this.hive.listAgents().length) return this.hive.listAgents();
    const base = { provider, cwd };
    this.hire({ ...base, name: 'Morgan', role: 'Boss / orchestrator', isBoss: true, skills: ['planning', 'routing', 'review'] });
    this.hire({ ...base, name: 'Ada', role: 'Backend engineer', skills: ['api', 'database', 'sql', 'node', 'python', 'auth', 'endpoint', 'server'] });
    this.hire({ ...base, name: 'Lin', role: 'Frontend engineer', skills: ['react', 'ui', 'css', 'design', 'component', 'page', 'button', 'dashboard'] });
    this.hire({ ...base, name: 'Sam', role: 'QA & test engineer', skills: ['test', 'testing', 'bug', 'regression', 'coverage', 'ci', 'e2e'] });
    this.hire({ ...base, name: 'Rio', role: 'DevOps & infra', skills: ['deploy', 'production', 'prod', 'docker', 'infra', 'pipeline', 'cloud', 'kubernetes', 'monitoring', 'release', 'ci'] });
    return this.hive.listAgents();
  }

  providers() {
    return PROVIDERS.map((p) => ({ id: p.id, label: p.label, describe: p.describe, keyEnv: p.keyEnv ?? [], bin: p.bin }));
  }
}
