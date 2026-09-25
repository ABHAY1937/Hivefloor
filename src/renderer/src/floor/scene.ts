// The office floor: a Canvas2D scene with a cached static layer (walls, floors,
// furniture) and a light dynamic layer (avatars, bubbles, envelopes, glows).
// Rendering is adaptive: 60fps while anything moves, ~8fps when the office is
// just "breathing", and zero work while the window is hidden.

import type { AgentSpec, AgentState, Lease, Station } from '../../../core/types';
import { SPRITE_H, SPRITE_W, sprite, type Pose } from './sprites';

export const T = 32; // world px per tile
const AISLE_Y = 8.9;
const SPEED = 3.4; // tiles / s

interface Pt {
  x: number;
  y: number;
}
interface Desk {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  seat: Pt;
  approach: Pt[]; // from aisle to seat
  boss: boolean;
}
interface Avatar {
  id: string;
  pos: Pt;
  path: Pt[];
  at: string; // location key
  approachOut: Pt[]; // path from current location back to the aisle
  pose: Pose;
  facing: 'front' | 'back';
  lastStateChange: number;
  note: string;
  station: Station;
}
interface Envelope {
  from: Pt;
  to: Pt;
  t0: number;
  dur: number;
  color: string;
}
interface Floaty {
  at: Pt;
  t0: number;
  glyph: 'book' | 'check';
}

export interface SceneData {
  agents: AgentSpec[];
  states: Record<string, AgentState>;
  leases: Lease[];
  unread: Record<string, number>;
  selected: string | null;
  pendingApprovals: number;
}

const COLORS = {
  wood: '#8c6a4e',
  woodLine: '#7b5b41',
  woodLight: '#977457',
  wall: '#efe3cf',
  wallTop: '#3a3346',
  base: '#6b5a4a',
  window: '#a9d8ea',
  bossCarpet: '#6d4c5e',
  bossCarpet2: '#654556',
  tile1: '#efe7d8',
  tile2: '#e2d8c5',
  deskTop: '#d2ad85',
  deskEdge: '#a8825e',
  bossDesk: '#6b4430',
  bossDeskEdge: '#4f3122',
  monitor: '#262a33',
  screenOff: '#39404d',
  glass: 'rgba(190,230,255,0.55)'
};

const STATUS_COLOR: Record<string, string> = {
  working: '#3ec17c',
  idle: '#9aa3b2',
  waiting: '#f5b841',
  blocked: '#e5534b',
  starting: '#58a6ff',
  offline: '#5b6270',
  error: '#e5534b'
};

export class Scene {
  private ctx: CanvasRenderingContext2D;
  private staticLayer: HTMLCanvasElement | null = null;
  private staticKey = '';
  private desks = new Map<string, Desk>();
  private avatars = new Map<string, Avatar>();
  private envelopes: Envelope[] = [];
  private floaties: Floaty[] = [];
  private data: SceneData = { agents: [], states: {}, leases: [], unread: {}, selected: null, pendingApprovals: 0 };
  private cols = 30;
  private rows = 18;
  private minRows = 18;
  private viewW = 0;
  private viewH = 0;
  private scale = 1;
  private offX = 0;
  private offY = 0;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private lastDraw = 0;
  hover: string | null = null;
  fps = 0;
  private frames = 0;
  private fpsT = 0;

  constructor(private canvas: HTMLCanvasElement) {
    this.ctx = canvas.getContext('2d', { alpha: false })!;
  }

  // ─── layout ───────────────────────────────────────────────────────────────

  private layout(): void {
    const workers = this.data.agents.filter((a) => !a.isBoss);
    const perRow = 5;
    const rowsOfDesks = Math.max(2, Math.ceil(workers.length / perRow));
    this.minRows = Math.max(15, Math.ceil(10.2 + rowsOfDesks * 3.6 + 0.6));
    this.cols = 30;
    this.fitRows();
    this.desks.clear();
    const boss = this.data.agents.find((a) => a.isBoss);
    if (boss) {
      this.desks.set(boss.id, {
        id: boss.id,
        x: 3,
        y: 3.6,
        w: 3.2,
        h: 1.5,
        seat: { x: 4.6, y: 5.75 },
        approach: [
          { x: 6.2, y: AISLE_Y },
          { x: 6.2, y: 6.9 },
          { x: 4.6, y: 6.9 },
          { x: 4.6, y: 5.75 }
        ],
        boss: true
      });
    }
    workers.forEach((a, i) => {
      const r = Math.floor(i / perRow);
      const c = i % perRow;
      const x = 2.6 + c * 4.6;
      const y = 10.3 + r * 3.6;
      const seat = { x: x + 1.4, y: y + 1.95 };
      const lane = x - 0.55;
      this.desks.set(a.id, {
        id: a.id,
        x,
        y,
        w: 2.8,
        h: 1.3,
        seat,
        approach: [
          { x: lane, y: AISLE_Y },
          { x: lane, y: seat.y },
          seat
        ],
        boss: false
      });
    });
  }

  private stationPoint(st: Station, index: number): { key: string; pt: Pt; approach: Pt[] } {
    const i = index % 6;
    switch (st) {
      case 'coffee': {
        const spots = [
          { x: 22.6, y: 6.1 },
          { x: 23.9, y: 6.5 },
          { x: 25.2, y: 6.2 },
          { x: 26.5, y: 6.6 },
          { x: 23.2, y: 7.4 },
          { x: 25.9, y: 7.5 }
        ];
        const pt = spots[i];
        return { key: `coffee${i}`, pt, approach: [{ x: pt.x, y: AISLE_Y }, pt] };
      }
      case 'whiteboard': {
        const pt = { x: 11.6 + i * 0.9, y: 4.3 };
        return { key: `wb${i}`, pt, approach: [{ x: pt.x, y: AISLE_Y }, pt] };
      }
      case 'archive': {
        const pt = { x: 17.1 + (i % 4) * 0.8, y: 4.3 };
        return { key: `ar${i}`, pt, approach: [{ x: pt.x, y: AISLE_Y }, pt] };
      }
      case 'boss-door': {
        const pt = { x: 7.3 + (i % 4) * 0.8, y: 8.2 };
        return { key: `bd${i}`, pt, approach: [{ x: pt.x, y: AISLE_Y }, pt] };
      }
      case 'server': {
        const pt = { x: 27.2, y: 10.8 + i * 0.9 };
        return { key: `sv${i}`, pt, approach: [{ x: 26.2, y: AISLE_Y }, { x: 26.2, y: pt.y }, pt] };
      }
      default:
        return { key: 'desk', pt: { x: 0, y: 0 }, approach: [] };
    }
  }

  private targetFor(a: AgentSpec, st: AgentState | undefined, index: number): { key: string; pt: Pt; approach: Pt[]; facing: 'front' | 'back' } {
    const desk = this.desks.get(a.id)!;
    const station = st?.station ?? 'desk';
    // Bosses mostly stay in their office; offline agents sit at their desk.
    if (station === 'desk' || !st || st.status === 'offline' || (a.isBoss && station !== 'whiteboard' && station !== 'archive')) {
      return { key: 'desk', pt: desk.seat, approach: desk.approach, facing: 'back' };
    }
    return { ...this.stationPoint(station, index), facing: 'front' };
  }

  // ─── data in ──────────────────────────────────────────────────────────────

  update(d: SceneData): void {
    const prevCount = this.data.agents.length;
    const prevStates = this.data.states;
    this.data = d;
    const key = d.agents.map((a) => `${a.id}:${a.isBoss}`).join(',');
    if (key !== this.staticKey || prevCount !== d.agents.length) {
      this.staticKey = key;
      this.layout();
      this.staticLayer = null;
    }
    const now = performance.now();
    d.agents.forEach((a, index) => {
      const st = d.states[a.id];
      const tgt = this.targetFor(a, st, index);
      let av = this.avatars.get(a.id);
      if (!av) {
        av = { id: a.id, pos: { ...tgt.pt }, path: [], at: tgt.key, approachOut: [...tgt.approach].reverse(), pose: 'back', facing: tgt.facing, lastStateChange: 0, note: '', station: 'desk' };
        this.avatars.set(a.id, av);
      }
      const prev = prevStates[a.id];
      if (st && (!prev || prev.note !== st.note || prev.status !== st.status)) av.lastStateChange = now;
      av.note = st?.note ?? '';
      if (tgt.key !== av.at) {
        // Walk: back out of where we are to the aisle, along it, then into the target.
        av.path = [...av.approachOut.slice(1), ...tgt.approach];
        av.at = tgt.key;
        av.approachOut = [...tgt.approach].reverse();
        av.facing = tgt.facing;
      }
    });
    for (const id of [...this.avatars.keys()]) if (!d.agents.some((a) => a.id === id)) this.avatars.delete(id);
    this.kick();
  }

  envelope(from: string, to: string, act: string): void {
    const a = this.anchor(from);
    const b = this.anchor(to);
    if (!a || !b) return;
    const color = act === 'done' ? '#3ec17c' : act === 'refuse' ? '#e5534b' : act === 'agree' ? '#3ec17c' : act === 'query' ? '#58a6ff' : '#f5b841';
    this.envelopes.push({ from: a, to: b, t0: performance.now(), dur: 950, color });
    this.kick();
  }

  memoryPulse(agent: string): void {
    const a = this.anchor(agent);
    if (a) this.floaties.push({ at: a, t0: performance.now(), glyph: 'book' });
    this.kick();
  }

  private anchor(id: string): Pt | null {
    if (id === 'human') return { x: 0.9, y: AISLE_Y - 0.4 };
    if (id === 'all') return { x: 15, y: AISLE_Y };
    const av = this.avatars.get(id);
    return av ? { x: av.pos.x, y: av.pos.y - 0.8 } : null;
  }

  // ─── sizing / input ───────────────────────────────────────────────────────

  /** Grow the floor downward to fill the view instead of letterboxing. */
  private fitRows(): void {
    const want = this.viewW > 0 ? Math.floor((this.cols * this.viewH) / this.viewW) : this.minRows;
    const rows = Math.max(this.minRows, Math.min(want, this.minRows + 7));
    if (rows !== this.rows) {
      this.rows = rows;
      this.staticLayer = null;
    }
  }

  resize(w: number, h: number): void {
    this.viewW = w;
    this.viewH = h;
    this.fitRows();
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.floor(w * this.dpr));
    this.canvas.height = Math.max(1, Math.floor(h * this.dpr));
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${h}px`;
    const worldW = this.cols * T;
    const worldH = this.rows * T;
    this.scale = Math.min(w / worldW, h / worldH);
    this.offX = (w - worldW * this.scale) / 2;
    this.offY = (h - worldH * this.scale) / 2;
    this.lastDraw = 0;
    this.kick();
  }

  /** Map a client point (relative to canvas) to an agent id, if any. */
  hit(cx: number, cy: number): string | null {
    const x = (cx - this.offX) / this.scale / T;
    const y = (cy - this.offY) / this.scale / T;
    let best: string | null = null;
    let bestD = 0.75;
    for (const av of this.avatars.values()) {
      const d = Math.hypot(av.pos.x - x, av.pos.y - 0.5 - y);
      if (d < bestD) {
        bestD = d;
        best = av.id;
      }
    }
    if (best) return best;
    for (const d of this.desks.values()) if (x >= d.x && x <= d.x + d.w && y >= d.y - 0.6 && y <= d.y + d.h) return d.id;
    return null;
  }

  // ─── loop ─────────────────────────────────────────────────────────────────

  kick(): void {
    if (!this.raf) this.raf = requestAnimationFrame((t) => this.frame(t));
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private frame(t: number): void {
    this.raf = 0;
    const dt = Math.min(0.05, (t - (this.lastFrame || t)) / 1000);
    this.lastFrame = t;
    let moving = false;
    for (const av of this.avatars.values()) {
      if (!av.path.length) continue;
      moving = true;
      let step = SPEED * dt;
      while (step > 0 && av.path.length) {
        const n = av.path[0];
        const dx = n.x - av.pos.x;
        const dy = n.y - av.pos.y;
        const d = Math.hypot(dx, dy);
        if (d <= step) {
          av.pos = { ...n };
          av.path.shift();
          step -= d;
        } else {
          av.pos.x += (dx / d) * step;
          av.pos.y += (dy / d) * step;
          step = 0;
        }
      }
    }
    const fx = this.envelopes.length > 0 || this.floaties.length > 0;
    const busy = moving || fx;
    // Adaptive frame rate: full speed while animating, a gentle idle tick otherwise.
    if (busy || t - this.lastDraw > 120) {
      this.draw(t);
      this.lastDraw = t;
      this.frames++;
    }
    if (t - this.fpsT > 1000) {
      this.fps = this.frames;
      this.frames = 0;
      this.fpsT = t;
    }
    if (!document.hidden) this.raf = requestAnimationFrame((tt) => this.frame(tt));
  }

  // ─── drawing ──────────────────────────────────────────────────────────────

  private draw(t: number): void {
    const g = this.ctx;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.fillStyle = '#15171c';
    g.fillRect(0, 0, this.canvas.width, this.canvas.height);
    if (!this.staticLayer) this.staticLayer = this.renderStatic();
    g.imageSmoothingEnabled = false;
    const s = this.scale * this.dpr;
    g.setTransform(s, 0, 0, s, this.offX * this.dpr, this.offY * this.dpr);
    g.drawImage(this.staticLayer, 0, 0);

    // Monitors glow for working agents; lease locks.
    const leased = new Set(this.data.leases.map((l) => l.agent));
    for (const d of this.desks.values()) {
      const st = this.data.states[d.id];
      const on = st && st.status !== 'offline' && st.status !== 'error';
      const mx = (d.x + d.w / 2 - 0.45) * T;
      const my = (d.y + 0.12) * T;
      g.fillStyle = !on ? COLORS.screenOff : st.status === 'working' ? (Math.floor(t / 260) % 2 ? '#7fd6ff' : '#6cc8f2') : st.status === 'waiting' ? '#f5c86b' : '#4f8fb3';
      g.fillRect(mx + 2, my + 2, 0.9 * T - 4, 0.5 * T - 4);
      if (st?.status === 'working') {
        g.fillStyle = 'rgba(20,30,40,0.55)';
        for (let i = 0; i < 3; i++) g.fillRect(mx + 5, my + 5 + i * 3, ((Math.sin(t / 300 + i * 2 + d.x) + 1.4) / 2.4) * (0.9 * T - 12), 1.5);
      }
      if (leased.has(d.id)) this.lock(g, (d.x + d.w - 0.35) * T, (d.y - 0.05) * T);
      if (d.id === this.data.selected) {
        g.strokeStyle = '#f5b841';
        g.lineWidth = 1.5;
        g.setLineDash([4, 3]);
        g.strokeRect(d.x * T - 4, (d.y - 0.1) * T - 4, d.w * T + 8, (d.h + 1.2) * T + 8);
        g.setLineDash([]);
      }
    }

    // Server LEDs
    for (let i = 0; i < 12; i++) {
      g.fillStyle = (Math.floor(t / 180) + i * 7) % 5 === 0 ? '#3ec17c' : (Math.floor(t / 400) + i) % 7 === 0 ? '#f5b841' : '#1f5135';
      g.fillRect((27.75 + (i % 2) * 0.35) * T, (10.25 + Math.floor(i / 2) * 0.55) * T, 3, 3);
    }

    // Avatars, sorted by y for depth.
    const avs = [...this.avatars.values()].sort((a, b) => a.pos.y - b.pos.y);
    for (const av of avs) this.drawAvatar(g, av, t);
    for (const av of avs) this.drawBubble(g, av, t);

    // Envelopes
    const now = performance.now();
    this.envelopes = this.envelopes.filter((e) => now - e.t0 < e.dur + 250);
    for (const e of this.envelopes) {
      const k = Math.min(1, (now - e.t0) / e.dur);
      const ease = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const x = (e.from.x + (e.to.x - e.from.x) * ease) * T;
      const dist = Math.hypot(e.to.x - e.from.x, e.to.y - e.from.y);
      const y = (e.from.y + (e.to.y - e.from.y) * ease) * T - Math.sin(Math.PI * ease) * Math.min(90, 20 + dist * 8);
      if (k < 1) {
        g.fillStyle = 'rgba(0,0,0,0.18)';
        g.beginPath();
        g.ellipse(x, (e.from.y + (e.to.y - e.from.y) * ease) * T + 4, 6, 2, 0, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fbf7ee';
        g.fillRect(x - 7, y - 5, 14, 10);
        g.strokeStyle = '#b9ae98';
        g.lineWidth = 1;
        g.strokeRect(x - 7, y - 5, 14, 10);
        g.beginPath();
        g.moveTo(x - 7, y - 5);
        g.lineTo(x, y + 1);
        g.lineTo(x + 7, y - 5);
        g.stroke();
        g.fillStyle = e.color;
        g.fillRect(x - 2, y - 1, 4, 3);
      } else {
        const r = (now - e.t0 - e.dur) / 250;
        g.strokeStyle = e.color;
        g.globalAlpha = 1 - r;
        g.beginPath();
        g.arc(e.to.x * T, e.to.y * T, 6 + r * 14, 0, Math.PI * 2);
        g.stroke();
        g.globalAlpha = 1;
      }
    }
    // Memory floaties
    this.floaties = this.floaties.filter((f) => now - f.t0 < 1200);
    for (const f of this.floaties) {
      const k = (now - f.t0) / 1200;
      g.globalAlpha = 1 - k;
      const x = f.at.x * T + 10;
      const y = f.at.y * T - 10 - k * 26;
      g.fillStyle = '#8e6cb5';
      g.fillRect(x - 5, y - 4, 10, 8);
      g.fillStyle = '#f2ecff';
      g.fillRect(x - 4, y - 3, 3.5, 6);
      g.fillRect(x + 0.5, y - 3, 3.5, 6);
      g.globalAlpha = 1;
    }
  }

  private lock(g: CanvasRenderingContext2D, x: number, y: number): void {
    g.fillStyle = '#f5b841';
    g.fillRect(x - 4, y - 1, 8, 6);
    g.strokeStyle = '#f5b841';
    g.lineWidth = 1.5;
    g.beginPath();
    g.arc(x, y - 1, 2.6, Math.PI, 0);
    g.stroke();
  }

  private drawAvatar(g: CanvasRenderingContext2D, av: Avatar, t: number): void {
    const spec = this.data.agents.find((a) => a.id === av.id);
    if (!spec) return;
    const st = this.data.states[av.id];
    const walking = av.path.length > 0;
    let pose: Pose;
    if (walking) pose = Math.floor(t / 140) % 2 ? 'walk1' : 'walk2';
    else if (av.facing === 'back') pose = st?.status === 'working' ? (Math.floor(t / 160) % 2 ? 'type1' : 'type2') : 'back';
    else pose = 'front';
    const img = sprite(spec.avatar, pose);
    const scale = 1.55;
    const w = SPRITE_W * scale;
    const h = SPRITE_H * scale;
    const x = av.pos.x * T - w / 2;
    const bob = !walking && st?.status === 'idle' ? Math.round(Math.sin(t / 700 + av.pos.x) * 0.8) : 0;
    const y = av.pos.y * T - h + 4 + bob;
    // shadow
    g.fillStyle = 'rgba(0,0,0,0.22)';
    g.beginPath();
    g.ellipse(av.pos.x * T, av.pos.y * T + 3, 9, 3.2, 0, 0, Math.PI * 2);
    g.fill();
    if (st?.status === 'offline') g.globalAlpha = 0.45;
    g.drawImage(img, Math.round(x), Math.round(y), w, h);
    g.globalAlpha = 1;
    if (spec.isBoss) {
      // tiny crown
      g.fillStyle = '#f5b841';
      const cx = av.pos.x * T;
      const cy = y - 3;
      g.beginPath();
      g.moveTo(cx - 6, cy + 3);
      g.lineTo(cx - 6, cy - 2);
      g.lineTo(cx - 3, cy + 1);
      g.lineTo(cx, cy - 3);
      g.lineTo(cx + 3, cy + 1);
      g.lineTo(cx + 6, cy - 2);
      g.lineTo(cx + 6, cy + 3);
      g.closePath();
      g.fill();
    }
    // Name tag
    const label = spec.name;
    g.font = '600 9px Inter, system-ui, sans-serif';
    const tw = g.measureText(label).width + 16;
    const lx = av.pos.x * T - tw / 2;
    const ly = av.pos.y * T + 7;
    g.fillStyle = av.id === this.data.selected ? 'rgba(245,184,65,0.95)' : av.id === this.hover ? 'rgba(40,44,54,0.95)' : 'rgba(22,24,30,0.82)';
    roundRect(g, lx, ly, tw, 13, 6.5);
    g.fill();
    g.fillStyle = STATUS_COLOR[st?.status ?? 'offline'];
    g.beginPath();
    g.arc(lx + 7, ly + 6.5, 2.6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = av.id === this.data.selected ? '#1b1d23' : '#eef0f4';
    g.textBaseline = 'middle';
    g.fillText(label, lx + 12, ly + 7);
    const unread = this.data.unread[av.id] ?? 0;
    if (unread > 0) {
      g.fillStyle = '#e5534b';
      g.beginPath();
      g.arc(lx + tw - 1, ly + 1, 5, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#fff';
      g.font = '700 7px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(unread > 9 ? '9+' : String(unread), lx + tw - 1, ly + 1.5);
      g.textAlign = 'left';
    }
  }

  private drawBubble(g: CanvasRenderingContext2D, av: Avatar, t: number): void {
    const st = this.data.states[av.id];
    if (!st) return;
    const recent = performance.now() - av.lastStateChange < 7000;
    const show = st.status === 'waiting' || av.id === this.hover || av.id === this.data.selected || (recent && st.status !== 'offline');
    if (!show || !av.note) {
      if (st.status === 'waiting') this.bang(g, av, t);
      return;
    }
    const text = av.note.length > 34 ? `${av.note.slice(0, 33)}…` : av.note;
    g.font = '500 8.5px Inter, system-ui, sans-serif';
    const w = g.measureText(text).width + 12;
    const x = Math.max(4, Math.min(this.cols * T - w - 4, av.pos.x * T - w / 2));
    const y = av.pos.y * T - SPRITE_H * 1.55 - 18;
    g.fillStyle = st.status === 'waiting' ? '#fff3d6' : '#ffffff';
    roundRect(g, x, y, w, 14, 5);
    g.fill();
    g.beginPath();
    g.moveTo(av.pos.x * T - 3, y + 14);
    g.lineTo(av.pos.x * T, y + 18);
    g.lineTo(av.pos.x * T + 3, y + 14);
    g.fill();
    g.fillStyle = '#23262e';
    g.textBaseline = 'middle';
    g.fillText(text, x + 6, y + 7.5);
    if (st.status === 'waiting') this.bang(g, av, t, y - 12);
  }

  private bang(g: CanvasRenderingContext2D, av: Avatar, t: number, yOverride?: number): void {
    const y = yOverride ?? av.pos.y * T - SPRITE_H * 1.55 - 14;
    const b = Math.sin(t / 180) * 1.5;
    g.fillStyle = '#f5b841';
    g.beginPath();
    g.arc(av.pos.x * T, y + b, 6, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#1b1d23';
    g.fillRect(av.pos.x * T - 1, y + b - 3.5, 2, 4.5);
    g.fillRect(av.pos.x * T - 1, y + b + 2, 2, 1.5);
  }

  private renderStatic(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.cols * T;
    c.height = this.rows * T;
    const g = c.getContext('2d')!;
    const W = this.cols * T;
    const H = this.rows * T;
    // Wood floor planks
    g.fillStyle = COLORS.wood;
    g.fillRect(0, 0, W, H);
    for (let y = 0; y < H; y += 12) {
      g.fillStyle = (y / 12) % 2 ? COLORS.woodLight : COLORS.wood;
      g.fillRect(0, y, W, 12);
      g.fillStyle = COLORS.woodLine;
      g.fillRect(0, y + 11, W, 1);
      const off = ((y / 12) * 53) % 96;
      for (let x = -off; x < W; x += 96) g.fillRect(x, y, 1, 11);
    }
    // Top wall with windows
    g.fillStyle = COLORS.wallTop;
    g.fillRect(0, 0, W, 0.35 * T);
    g.fillStyle = COLORS.wall;
    g.fillRect(0, 0.35 * T, W, 1.9 * T);
    g.fillStyle = COLORS.base;
    g.fillRect(0, 2.2 * T, W, 0.18 * T);
    for (let x = 1; x < this.cols - 1; x += 3.2) {
      if (x > 10.5 && x < 21) continue;
      g.fillStyle = '#8a7a66';
      g.fillRect(x * T - 2, 0.6 * T - 2, 1.8 * T + 4, 1.2 * T + 4);
      const grd = g.createLinearGradient(0, 0.6 * T, 0, 1.8 * T);
      grd.addColorStop(0, '#cdeefa');
      grd.addColorStop(1, COLORS.window);
      g.fillStyle = grd;
      g.fillRect(x * T, 0.6 * T, 1.8 * T, 1.2 * T);
      g.fillStyle = 'rgba(255,255,255,0.5)';
      g.fillRect(x * T + 4, 0.6 * T + 4, 5, 1.2 * T - 8);
      g.fillStyle = '#8a7a66';
      g.fillRect(x * T + 0.9 * T - 1, 0.6 * T, 2, 1.2 * T);
    }
    // Side walls
    g.fillStyle = COLORS.wallTop;
    g.fillRect(0, 0, 0.3 * T, H);
    g.fillRect(W - 0.3 * T, 0, 0.3 * T, H);
    g.fillRect(0, H - 0.3 * T, W, 0.3 * T);

    // Boss office: carpet + glass walls
    g.fillStyle = COLORS.bossCarpet;
    g.fillRect(0.3 * T, 2.4 * T, 8.7 * T, 5.6 * T);
    for (let y = 2.4; y < 8; y += 0.5) for (let x = 0.3; x < 9; x += 0.5) if ((Math.round(x * 2) + Math.round(y * 2)) % 2) {
      g.fillStyle = COLORS.bossCarpet2;
      g.fillRect(x * T, y * T, 0.5 * T, 0.5 * T);
    }
    g.fillStyle = COLORS.glass;
    g.fillRect(9 * T, 2.4 * T, 4, 5.6 * T);
    g.fillRect(0.3 * T, 8 * T - 4, 5.4 * T, 4);
    g.fillRect(6.9 * T, 8 * T - 4, 2.1 * T + 4, 4);
    g.fillStyle = 'rgba(255,255,255,0.35)';
    g.fillRect(9 * T + 1, 2.6 * T, 1, 5 * T);
    // Boss nameplate on door
    g.fillStyle = '#3a3346';
    g.fillRect(6 * T, 8 * T - 10, 0.8 * T, 8);
    g.fillStyle = '#f5b841';
    g.font = '700 6px Inter, system-ui, sans-serif';
    g.fillText('BOSS', 6 * T + 4, 8 * T - 4);
    // Boss desk + plant + sofa
    const bd = [...this.desks.values()].find((d) => d.boss);
    if (bd) this.deskShape(g, bd, true);
    this.plant(g, 1.0, 3.0);
    this.plant(g, 8.2, 3.0);
    g.fillStyle = '#44506a';
    g.fillRect(1 * T, 6.3 * T, 0.7 * T, 1.4 * T);
    g.fillStyle = '#56627e';
    g.fillRect(1.1 * T, 6.4 * T, 0.5 * T, 1.2 * T);

    // Whiteboard
    g.fillStyle = '#9aa0a8';
    g.fillRect(11 * T - 3, 0.55 * T - 3, 5 * T + 6, 1.55 * T + 6);
    g.fillStyle = '#fbfbf8';
    g.fillRect(11 * T, 0.55 * T, 5 * T, 1.55 * T);
    const scribble = ['#e5534b', '#3e8e7e', '#4f7cac', '#8e6cb5'];
    for (let i = 0; i < 6; i++) {
      g.fillStyle = scribble[i % 4];
      g.fillRect(11.3 * T, (0.75 + i * 0.22) * T, (1.2 + ((i * 37) % 30) / 10) * T, 2);
    }
    g.fillStyle = '#e5534b';
    g.fillRect(15.2 * T, 0.8 * T, 0.5 * T, 0.5 * T);
    g.fillStyle = '#f5b841';
    g.fillRect(15.2 * T, 1.4 * T, 0.5 * T, 0.5 * T);
    this.caption(g, 'PLAN', 13.5, 2.6);

    // Archive shelves (memory)
    for (let s = 0; s < 2; s++) {
      const x = (16.9 + s * 1.7) * T;
      g.fillStyle = '#5e3d2b';
      g.fillRect(x, 0.5 * T, 1.5 * T, 1.9 * T);
      for (let r = 0; r < 3; r++) {
        g.fillStyle = '#4a2f21';
        g.fillRect(x + 2, (0.55 + r * 0.62) * T + 17, 1.5 * T - 4, 3);
        for (let b = 0; b < 7; b++) {
          g.fillStyle = ['#c8553d', '#4f7cac', '#3e8e7e', '#d98e04', '#8e6cb5', '#eadbc0'][(b + r * 3 + s) % 6];
          g.fillRect(x + 4 + b * 6, (0.55 + r * 0.62) * T + 4 + ((b * 5) % 4), 5, 13 - ((b * 5) % 4));
        }
      }
    }
    this.caption(g, 'MEMORY', 18.6, 2.6);

    // Kitchen / coffee corner
    g.fillStyle = COLORS.tile1;
    g.fillRect(21.5 * T, 2.4 * T, 8.2 * T, 5.5 * T);
    for (let y = 2.4; y < 7.9; y += 0.5) for (let x = 21.5; x < 29.7; x += 0.5) if ((Math.round(x * 2) + Math.round(y * 2)) % 2) {
      g.fillStyle = COLORS.tile2;
      g.fillRect(x * T, y * T, 0.5 * T, 0.5 * T);
    }
    g.fillStyle = '#7f8b99';
    g.fillRect(21.8 * T, 2.45 * T, 7.6 * T, 0.9 * T);
    g.fillStyle = '#a7b3c0';
    g.fillRect(21.8 * T, 2.45 * T, 7.6 * T, 0.2 * T);
    // coffee machine
    g.fillStyle = '#2a2f3a';
    g.fillRect(23 * T, 1.7 * T, 0.9 * T, 1.3 * T);
    g.fillStyle = '#e5534b';
    g.fillRect(23.2 * T, 1.95 * T, 4, 4);
    g.fillStyle = '#c9c2b3';
    g.fillRect(23.25 * T, 2.6 * T, 0.4 * T, 0.3 * T);
    // fridge
    g.fillStyle = '#dfe6ec';
    g.fillRect(28.2 * T, 1.3 * T, 1.2 * T, 2 * T);
    g.fillStyle = '#9aa7b3';
    g.fillRect(28.3 * T, 2.1 * T, 1.0 * T, 2);
    // mugs
    for (let i = 0; i < 3; i++) {
      g.fillStyle = ['#f5b841', '#4f7cac', '#fbf7ee'][i];
      g.fillRect((24.5 + i * 0.5) * T, 2.7 * T, 8, 9);
    }
    // round table + stools
    g.fillStyle = '#b98b5e';
    g.beginPath();
    g.ellipse(24.6 * T, 5.2 * T, 1.3 * T, 0.7 * T, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = '#a07650';
    g.fillRect(23.6 * T, 5.2 * T, 2 * T, 0.12 * T);
    this.plant(g, 28.8, 6.4);
    this.caption(g, 'COFFEE', 25.6, 4.0);

    // Server rack
    g.fillStyle = '#23262e';
    g.fillRect(27.5 * T, 9.9 * T, 1.3 * T, 3.6 * T);
    g.fillStyle = '#2f343f';
    for (let i = 0; i < 6; i++) g.fillRect(27.6 * T, (10.1 + i * 0.55) * T, 1.1 * T, 0.42 * T);
    this.caption(g, 'CI / SERVERS', 28.1, 13.9);

    // Human mailbox (left door)
    g.fillStyle = '#3a3346';
    g.fillRect(0, (AISLE_Y - 1.2) * T, 0.35 * T, 1.8 * T);
    g.fillStyle = '#f5b841';
    g.fillRect(0.35 * T, (AISLE_Y - 0.8) * T, 0.9 * T, 0.7 * T);
    g.fillStyle = '#1b1d23';
    g.fillRect(0.5 * T, (AISLE_Y - 0.6) * T, 0.6 * T, 3);
    this.caption(g, 'YOU', 0.8, AISLE_Y + 0.4);

    // Worker desks
    for (const d of this.desks.values()) if (!d.boss) this.deskShape(g, d, false);
    // Plants along the aisle
    this.plant(g, 21.0, 9.4);
    // Lounge + meeting room in the spare floor below the desks.
    const spare = this.rows - this.minRows;
    if (spare >= 3) {
      const ly = this.rows - 3.9;
      // meeting table
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(3.1 * T, (ly + 1.1) * T, 6 * T, 1.5 * T);
      g.fillStyle = '#6b4430';
      g.fillRect(3 * T, (ly + 0.9) * T, 6 * T, 1.4 * T);
      g.fillStyle = '#7d5139';
      g.fillRect(3 * T, (ly + 0.9) * T, 6 * T, 0.25 * T);
      for (let i = 0; i < 4; i++) {
        g.fillStyle = '#39404f';
        g.fillRect((3.5 + i * 1.5) * T, (ly + 0.35) * T, 16, 12);
        g.fillRect((3.5 + i * 1.5) * T, (ly + 2.45) * T, 16, 12);
      }
      g.fillStyle = '#fbf7ee';
      g.fillRect(4.2 * T, (ly + 1.3) * T, 14, 10);
      g.fillRect(7.1 * T, (ly + 1.4) * T, 14, 10);
      this.caption(g, 'MEETING', 6, ly + 3.25);
      // lounge rug, sofa, bean bags
      g.fillStyle = '#5e7f8f';
      roundRect(g, 18 * T, (ly + 0.1) * T, 7.5 * T, 3.1 * T, 14);
      g.fill();
      g.strokeStyle = '#7fa2b1';
      g.lineWidth = 3;
      roundRect(g, 18.3 * T, (ly + 0.4) * T, 6.9 * T, 2.5 * T, 10);
      g.stroke();
      g.fillStyle = '#c8553d';
      g.fillRect(18.6 * T, (ly + 0.25) * T, 4 * T, 0.8 * T);
      g.fillStyle = '#b04632';
      g.fillRect(18.6 * T, (ly + 0.25) * T, 4 * T, 0.25 * T);
      g.fillStyle = '#e0a458';
      g.beginPath();
      g.ellipse(23.8 * T, (ly + 1.3) * T, 0.6 * T, 0.45 * T, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#4f7cac';
      g.beginPath();
      g.ellipse(22.9 * T, (ly + 2.4) * T, 0.55 * T, 0.42 * T, 0, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#d2ad85';
      g.fillRect(19.9 * T, (ly + 1.7) * T, 1.6 * T, 0.9 * T);
      this.caption(g, 'LOUNGE', 21.7, ly + 3.25);
    }
    this.plant(g, 1.2, this.rows - 1.3);
    this.plant(g, 28.7, this.rows - 1.3);
    this.plant(g, 15.0, this.rows - 1.3);
    return c;
  }

  private caption(g: CanvasRenderingContext2D, text: string, cx: number, cy: number): void {
    g.font = '700 7px Inter, system-ui, sans-serif';
    const w = g.measureText(text).width + 8;
    g.fillStyle = 'rgba(30,26,40,0.55)';
    roundRect(g, cx * T - w / 2, cy * T - 5, w, 10, 3);
    g.fill();
    g.fillStyle = '#f1e9da';
    g.textBaseline = 'middle';
    g.textAlign = 'center';
    g.fillText(text, cx * T, cy * T);
    g.textAlign = 'left';
  }

  private plant(g: CanvasRenderingContext2D, x: number, y: number): void {
    g.fillStyle = '#b5651d';
    g.fillRect(x * T - 6, y * T, 12, 10);
    g.fillStyle = '#9a541a';
    g.fillRect(x * T - 6, y * T, 12, 2);
    g.fillStyle = '#4c9a5a';
    for (const [dx, dy, r] of [[0, -6, 7], [-6, -2, 5], [6, -2, 5], [0, -12, 5]] as const) {
      g.beginPath();
      g.arc(x * T + dx, y * T + dy, r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#5fb56d';
    g.beginPath();
    g.arc(x * T - 2, y * T - 8, 3, 0, Math.PI * 2);
    g.fill();
  }

  private deskShape(g: CanvasRenderingContext2D, d: Desk, boss: boolean): void {
    const x = d.x * T;
    const y = d.y * T;
    const w = d.w * T;
    const h = d.h * T;
    // chair (behind avatar)
    g.fillStyle = boss ? '#3a2a45' : '#39404f';
    g.fillRect(d.seat.x * T - 9, d.seat.y * T - 22, 18, 16);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect(x + 3, y + h, w - 6, 4);
    g.fillStyle = boss ? COLORS.bossDeskEdge : COLORS.deskEdge;
    g.fillRect(x, y + 6, w, h - 2);
    g.fillStyle = boss ? COLORS.bossDesk : COLORS.deskTop;
    g.fillRect(x, y, w, h - 6);
    // monitor
    const mx = (d.x + d.w / 2 - 0.45) * T;
    const my = (d.y + 0.12) * T;
    g.fillStyle = COLORS.monitor;
    g.fillRect(mx, my, 0.9 * T, 0.5 * T);
    g.fillRect(mx + 0.4 * T, my + 0.5 * T, 0.1 * T, 5);
    // keyboard + mug + papers
    g.fillStyle = '#d9dde3';
    g.fillRect(mx + 4, y + h - 14, 0.9 * T - 8, 4);
    g.fillStyle = '#fbf7ee';
    g.fillRect(x + 6, y + 6, 12, 9);
    g.fillStyle = boss ? '#f5b841' : '#c8553d';
    g.fillRect(x + w - 14, y + 7, 7, 8);
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}
