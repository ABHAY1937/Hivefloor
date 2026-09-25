// Terminal plane. Each agent runs as a real process in a pseudo-terminal.
//
// Performance design (vs. one IPC message per onData chunk):
//  - Output from ALL sessions is coalesced and flushed once per frame (~16ms) as a
//    single batch, so 10 chatty agents cost ~60 IPC messages/s total, not thousands.
//  - Per-session ring buffer (default 512 KB) lets a terminal view attach late and
//    replay instantly without the main process holding unbounded scrollback.
//  - Flow control: if a session's un-acknowledged output exceeds the high-water mark
//    the PTY is paused, and resumed when the consumer acks — a runaway `cat` of a
//    huge file cannot freeze the UI or balloon memory.
//  - Idle detection from output quiescence drives avatar state for CLIs that don't
//    report status themselves.
// node-pty is loaded lazily; if unavailable, falls back to pipes so the harness
// still works (without full TTY semantics).

import { spawn as cpSpawn, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { Bus } from './bus';

export interface PtySpawnOptions {
  id: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols?: number;
  rows?: number;
}

export interface PtyBatchItem {
  id: string;
  data: string;
}

export interface PtyEvents extends Record<string, unknown> {
  batch: PtyBatchItem[];
  exit: { id: string; exitCode: number | null; signal?: number | string | null };
  activity: { id: string; active: boolean };
}

interface IPty {
  pid: number;
  write(d: string): void;
  resize(c: number, r: number): void;
  kill(signal?: string): void;
  pause?(): void;
  resume?(): void;
  onData(cb: (d: string) => void): unknown;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): unknown;
}

class Ring {
  private chunks: string[] = [];
  private size = 0;
  constructor(private readonly cap: number) {}
  push(s: string): void {
    this.chunks.push(s);
    this.size += s.length;
    while (this.size > this.cap && this.chunks.length > 1) this.size -= this.chunks.shift()!.length;
    if (this.size > this.cap) {
      this.chunks[0] = this.chunks[0].slice(this.size - this.cap);
      this.size = this.cap;
    }
  }
  read(): string {
    if (this.chunks.length > 1) this.chunks = [this.chunks.join('')];
    return this.chunks[0] ?? '';
  }
}

interface Session {
  id: string;
  proc: IPty;
  ring: Ring;
  pending: string;
  unacked: number;
  paused: boolean;
  active: boolean;
  lastOutput: number;
  bytesTotal: number;
}

export interface PtyManagerOptions {
  frameMs?: number;
  ringBytes?: number;
  highWater?: number;
  lowWater?: number;
  idleMs?: number;
}

let nodePty: { spawn: (f: string, a: string[], o: Record<string, unknown>) => IPty } | null | undefined;
function loadNodePty() {
  if (nodePty !== undefined) return nodePty;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    nodePty = require('node-pty');
    if (process.platform === 'darwin') ensureSpawnHelperExecutable();
  } catch (e) {
    console.warn('[pty] node-pty unavailable, falling back to pipes:', (e as Error).message);
    nodePty = null;
  }
  return nodePty;
}

/**
 * node-pty's macOS prebuilt `spawn-helper` can ship without its exec bit, and then
 * every spawn fails with "posix_spawnp failed". Restore it once at load time.
 */
function ensureSpawnHelperExecutable(): void {
  try {
    const root = dirname(require.resolve('node-pty/package.json')).replace('app.asar', 'app.asar.unpacked');
    for (const dir of [join(root, 'build', 'Release'), join(root, 'prebuilds', `darwin-${process.arch}`)]) {
      const helper = join(dir, 'spawn-helper');
      if (existsSync(helper) && (statSync(helper).mode & 0o111) === 0) chmodSync(helper, 0o755);
    }
  } catch (e) {
    console.warn('[pty] could not check spawn-helper permissions:', (e as Error).message);
  }
}

export class PtyManager {
  readonly bus = new Bus<PtyEvents>();
  private sessions = new Map<string, Session>();
  private flushTimer: NodeJS.Timeout | null = null;
  private idleTimer: NodeJS.Timeout | null = null;
  private readonly o: Required<PtyManagerOptions>;
  /** When false, flow control never pauses (headless use with no consumer acks). */
  flowControl = true;

  constructor(opts: PtyManagerOptions = {}) {
    this.o = { frameMs: 16, ringBytes: 512 * 1024, highWater: 2 * 1024 * 1024, lowWater: 256 * 1024, idleMs: 2500, ...opts };
    this.idleTimer = setInterval(() => this.checkIdle(), 500);
    this.idleTimer.unref?.();
  }

  get backend(): 'node-pty' | 'pipes' {
    return loadNodePty() ? 'node-pty' : 'pipes';
  }

  has(id: string): boolean {
    return this.sessions.has(id);
  }

  pid(id: string): number | undefined {
    return this.sessions.get(id)?.proc.pid;
  }

  spawn(o: PtySpawnOptions): number {
    if (this.sessions.has(o.id)) throw new Error(`session ${o.id} already running`);
    const np = loadNodePty();
    const proc: IPty = np
      ? np.spawn(resolveCommand(o.command, o.env), o.args, {
          name: 'xterm-256color',
          cols: o.cols ?? 120,
          rows: o.rows ?? 32,
          cwd: o.cwd,
          env: o.env,
          useConpty: true
        })
      : pipeSpawn(o);
    const s: Session = {
      id: o.id,
      proc,
      ring: new Ring(this.o.ringBytes),
      pending: '',
      unacked: 0,
      paused: false,
      active: true,
      lastOutput: Date.now(),
      bytesTotal: 0
    };
    this.sessions.set(o.id, s);
    proc.onData((d) => {
      if (this.sessions.get(o.id) !== s) return; // stale output from a replaced session
      s.ring.push(d);
      s.pending += d;
      s.bytesTotal += d.length;
      s.lastOutput = Date.now();
      if (!s.active) {
        s.active = true;
        this.bus.emit('activity', { id: o.id, active: true });
      }
      if (this.flowControl) {
        s.unacked += d.length;
        if (!s.paused && s.unacked > this.o.highWater && proc.pause) {
          s.paused = true;
          proc.pause();
        }
      }
      this.scheduleFlush();
    });
    proc.onExit(({ exitCode, signal }) => {
      if (this.sessions.get(o.id) !== s) return;
      this.flush();
      this.sessions.delete(o.id);
      this.bus.emit('exit', { id: o.id, exitCode, signal });
    });
    return proc.pid;
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.o.frameMs);
  }

  /** Emit one batch containing pending output of every session. */
  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    const batch: PtyBatchItem[] = [];
    for (const s of this.sessions.values()) {
      if (s.pending) {
        batch.push({ id: s.id, data: s.pending });
        s.pending = '';
      }
    }
    if (batch.length) this.bus.emit('batch', batch);
  }

  /** Consumer acknowledges it rendered `bytes` of a session's output. */
  ack(id: string, bytes: number): void {
    const s = this.sessions.get(id);
    if (!s) return;
    s.unacked = Math.max(0, s.unacked - bytes);
    if (s.paused && s.unacked < this.o.lowWater) {
      s.paused = false;
      s.proc.resume?.();
    }
  }

  replay(id: string): string {
    return this.sessions.get(id)?.ring.read() ?? '';
  }

  write(id: string, data: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.proc.write(data);
    return true;
  }

  /**
   * Type a line into an interactive CLI like a human would. Many TUIs treat a
   * pasted "\r" inside a burst as a newline in the input box, so the submit key is
   * sent separately after a short delay.
   */
  typeLine(id: string, text: string): boolean {
    const s = this.sessions.get(id);
    if (!s) return false;
    s.proc.write(text.replace(/\r?\n/g, ' '));
    setTimeout(() => this.sessions.get(id)?.proc.write('\r'), 120);
    return true;
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id);
    if (s && cols > 0 && rows > 0) {
      try {
        s.proc.resize(Math.floor(cols), Math.floor(rows));
      } catch {
        /* process may be exiting */
      }
    }
  }

  isActive(id: string): boolean {
    return this.sessions.get(id)?.active ?? false;
  }

  stats(): { id: string; bytes: number; paused: boolean; active: boolean }[] {
    return [...this.sessions.values()].map((s) => ({ id: s.id, bytes: s.bytesTotal, paused: s.paused, active: s.active }));
  }

  kill(id: string): void {
    const s = this.sessions.get(id);
    if (!s) return;
    try {
      s.proc.kill();
    } catch {
      /* already gone */
    }
  }

  killAll(): void {
    for (const id of [...this.sessions.keys()]) this.kill(id);
    if (this.idleTimer) clearInterval(this.idleTimer);
  }

  private checkIdle(): void {
    const now = Date.now();
    for (const s of this.sessions.values()) {
      if (s.active && now - s.lastOutput > this.o.idleMs) {
        s.active = false;
        this.bus.emit('activity', { id: s.id, active: false });
      }
    }
  }
}

/**
 * ConPTY does not search PATH/PATHEXT the way a shell does, so on Windows a bare
 * name like `bash` or `claude` (really `claude.cmd`) fails with "File not found".
 * Resolve it against the agent's own PATH first.
 */
export function resolveCommand(command: string, env: Record<string, string>): string {
  if (process.platform !== 'win32' || /[\\/]/.test(command)) return command;
  const pathVar = env.PATH ?? env.Path ?? process.env.PATH ?? '';
  const exts = (env.PATHEXT ?? process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const hasExt = /\.[a-z0-9]+$/i.test(command);
  for (const dir of pathVar.split(delimiter).filter(Boolean)) {
    for (const ext of hasExt ? [''] : exts) {
      const full = join(dir, command + ext);
      if (existsSync(full)) return full;
    }
  }
  return command;
}

/** Fallback when node-pty can't load: plain pipes wrapped in the IPty shape. */
function pipeSpawn(o: PtySpawnOptions): IPty {
  const cp: ChildProcess = cpSpawn(o.command, o.args, {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    shell: process.platform === 'win32'
  });
  const dataCbs: ((d: string) => void)[] = [];
  const emit = (b: Buffer) => {
    const s = b.toString('utf8').replace(/(?<!\r)\n/g, '\r\n');
    for (const cb of dataCbs) cb(s);
  };
  cp.stdout?.on('data', emit);
  cp.stderr?.on('data', emit);
  return {
    pid: cp.pid ?? -1,
    write: (d) => cp.stdin?.write(d.replace(/\r/g, '\n')),
    resize: () => {},
    kill: (sig) => cp.kill((sig as NodeJS.Signals) ?? 'SIGTERM'),
    pause: () => {
      cp.stdout?.pause();
      cp.stderr?.pause();
    },
    resume: () => {
      cp.stdout?.resume();
      cp.stderr?.resume();
    },
    onData: (cb) => dataCbs.push(cb),
    onExit: (cb) => cp.on('exit', (code, signal) => cb({ exitCode: code ?? -1, signal: signal ? 1 : undefined }))
  };
}
