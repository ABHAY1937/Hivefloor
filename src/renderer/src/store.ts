// Renderer store: mirrors the hive by applying the same event stream the main
// process persists. Immutable top-level replacement per batch (≤30/s) keeps React
// simple; the canvas floor and terminals read the store directly without React.

import { useSyncExternalStore } from 'react';
import { hf } from './api';
import type {
  AgentSpec,
  AgentState,
  Approval,
  HiveMessage,
  Lease,
  LiveSignal,
  MemoryEntry,
  SequencedEvent,
  Task
} from '../../core/types';

export interface ProviderInfo {
  id: string;
  label: string;
  describe: string;
  keyEnv: string[];
  bin: string;
}
export interface SettingsView {
  llm: { baseUrl: string; model: string; api: 'openai' | 'anthropic' };
  secrets: string[];
  policy: { spendThresholdUsd?: number; bigChangeFiles?: number; alwaysAsk?: string[]; neverAsk?: string[] };
  workspace: string;
}
export interface ActivityItem {
  at: number;
  kind: 'msg' | 'task' | 'approval' | 'memory' | 'agent' | 'log';
  agent?: string;
  text: string;
}
export type PanelTab = 'boss' | 'agent' | 'approvals' | 'tasks' | 'memory' | 'activity';

export interface State {
  ready: boolean;
  home: string;
  backend: string;
  agents: Record<string, AgentSpec>;
  states: Record<string, AgentState>;
  messages: HiveMessage[];
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  memory: MemoryEntry[];
  board: string;
  leases: Lease[];
  providers: ProviderInfo[];
  settings: SettingsView | null;
  activity: ActivityItem[];
  selected: string | null;
  tab: PanelTab;
  modal: null | 'hire' | 'settings';
}

export type Fx = { t: 'envelope'; from: string; to: string; act: string } | { t: 'memory'; agent: string };

const MAX_MSGS = 1000;
const MAX_ACTIVITY = 400;

class Store {
  state: State = {
    ready: false,
    home: '',
    backend: '',
    agents: {},
    states: {},
    messages: [],
    tasks: {},
    approvals: {},
    memory: [],
    board: '',
    leases: [],
    providers: [],
    settings: null,
    activity: [],
    selected: null,
    tab: 'boss',
    modal: null
  };
  private listeners = new Set<() => void>();
  private fxListeners = new Set<(fx: Fx) => void>();
  private seq = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };
  onFx(fn: (fx: Fx) => void) {
    this.fxListeners.add(fn);
    return () => this.fxListeners.delete(fn);
  }
  private emit(): void {
    for (const l of this.listeners) l();
  }
  set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    this.emit();
  }

  async init(): Promise<void> {
    const d = await hf().call<{
      home: string;
      backend: string;
      agents: AgentSpec[];
      states: Record<string, AgentState>;
      messages: HiveMessage[];
      tasks: Task[];
      approvals: Approval[];
      memory: MemoryEntry[];
      board: string;
      leases: Lease[];
      providers: ProviderInfo[];
      settings: SettingsView;
      seq: number;
    }>('init');
    this.seq = d.seq;
    this.state = {
      ...this.state,
      ready: true,
      home: d.home,
      backend: d.backend,
      agents: Object.fromEntries(d.agents.map((a) => [a.id, a])),
      states: d.states,
      messages: d.messages,
      tasks: Object.fromEntries(d.tasks.map((t) => [t.id, t])),
      approvals: Object.fromEntries(d.approvals.map((a) => [a.id, a])),
      memory: d.memory,
      board: d.board,
      leases: d.leases,
      providers: d.providers,
      settings: d.settings,
      activity: d.messages.slice(-60).map((m) => this.msgActivity(m))
    };
    this.emit();
    hf().on('hf:events', (p: { hive: SequencedEvent[]; signals: LiveSignal[] }) => this.applyBatch(p));
  }

  private msgActivity(m: HiveMessage): ActivityItem {
    return { at: m.createdAt, kind: 'msg', agent: m.from, text: `${m.from} → ${m.to} · ${m.act}: ${m.subject}` };
  }

  private applyBatch(p: { hive: SequencedEvent[]; signals: LiveSignal[] }): void {
    const s = { ...this.state };
    let agents = s.agents;
    let tasks = s.tasks;
    let approvals = s.approvals;
    let messages = s.messages;
    let memory = s.memory;
    let states = s.states;
    const activity: ActivityItem[] = [];
    const fx: Fx[] = [];

    for (const se of p.hive) {
      if (se.seq <= this.seq) continue;
      this.seq = se.seq;
      const ev = se.ev;
      switch (ev.t) {
        case 'agent.add':
          agents = { ...agents, [ev.spec.id]: ev.spec };
          activity.push({ at: se.at, kind: 'agent', agent: ev.spec.id, text: `${ev.spec.name} joined as ${ev.spec.role}` });
          break;
        case 'agent.update':
          if (agents[ev.id]) agents = { ...agents, [ev.id]: { ...agents[ev.id], ...ev.patch } };
          break;
        case 'agent.remove': {
          agents = { ...agents };
          delete agents[ev.id];
          if (s.selected === ev.id) s.selected = null;
          break;
        }
        case 'msg.send':
          messages = [...messages, ev.msg].slice(-MAX_MSGS);
          activity.push(this.msgActivity(ev.msg));
          fx.push({ t: 'envelope', from: ev.msg.from, to: ev.msg.to, act: ev.msg.act });
          break;
        case 'msg.read': {
          const ids = new Set(ev.ids);
          messages = messages.map((m) => (ids.has(m.id) && !m.readAt ? { ...m, readAt: ev.at } : m));
          break;
        }
        case 'task.put': {
          const prev = tasks[ev.task.id];
          tasks = { ...tasks, [ev.task.id]: ev.task };
          if (!prev || prev.status !== ev.task.status)
            activity.push({ at: se.at, kind: 'task', agent: ev.task.assignee ?? undefined, text: `task ${ev.task.status}: ${ev.task.title}` });
          break;
        }
        case 'approval.put':
          approvals = { ...approvals, [ev.approval.id]: ev.approval };
          activity.push({ at: se.at, kind: 'approval', agent: ev.approval.agent, text: `approval ${ev.approval.status} (${ev.approval.kind}): ${ev.approval.summary}` });
          break;
        case 'memory.add':
          memory = [ev.entry, ...memory].slice(0, 5000);
          activity.push({ at: se.at, kind: 'memory', agent: ev.entry.agent, text: `remembered: ${ev.entry.text}` });
          fx.push({ t: 'memory', agent: ev.entry.agent });
          break;
        case 'memory.remove':
          memory = memory.filter((m) => m.id !== ev.id);
          break;
        case 'board.set':
          s.board = ev.text;
          break;
      }
    }
    for (const sig of p.signals) {
      if (sig.t === 'agent.state') states = { ...states, [sig.id]: sig.state };
      else if (sig.t === 'lease.change') s.leases = sig.leases;
      else if (sig.t === 'log') activity.push({ at: Date.now(), kind: 'log', agent: sig.agent, text: sig.text });
    }
    this.state = {
      ...s,
      agents,
      tasks,
      approvals,
      messages,
      memory,
      states,
      activity: activity.length ? [...s.activity, ...activity].slice(-MAX_ACTIVITY) : s.activity
    };
    this.emit();
    for (const f of fx) for (const l of this.fxListeners) l(f);
  }
}

export const store = new Store();

export function useStore<T>(sel: (s: State) => T): T {
  return useSyncExternalStore(store.subscribe, () => sel(store.state));
}

export const call = <T = unknown>(method: string, ...args: unknown[]) => hf().call<T>(method, ...args);

export function select(id: string | null, tab: PanelTab = 'agent'): void {
  store.set({ selected: id, tab: id ? tab : store.state.tab === 'agent' ? 'boss' : store.state.tab });
}
