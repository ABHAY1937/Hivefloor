// Shared domain types for the Hivefloor harness. Pure data — no Node or DOM imports,
// so the renderer can import these too.

export type AgentStatus = 'offline' | 'starting' | 'idle' | 'working' | 'waiting' | 'blocked' | 'error';
export type Station = 'desk' | 'coffee' | 'whiteboard' | 'archive' | 'boss-door' | 'server';

export interface AvatarLook {
  shirt: string;
  hair: string;
  skin: string;
}

export interface AgentSpec {
  id: string;
  name: string;
  role: string;
  /** Free-text skills used by the router to match tasks to agents. */
  skills: string[];
  provider: string;
  model?: string;
  /** Working directory the agent's terminal starts in. */
  cwd: string;
  /** 'shared' runs in cwd; 'worktree' gets its own git worktree + branch. */
  isolation: 'shared' | 'worktree';
  isBoss: boolean;
  avatar: AvatarLook;
  /** Custom command override (provider 'custom'). */
  command?: string;
  args?: string[];
  /** Extra stored secrets this agent may receive, beyond its provider's own keys. */
  secrets?: string[];
  /** 'docker' runs the agent in a locked-down container (specs/003-agent-sandbox). */
  sandbox?: 'none' | 'docker';
  /** Container image for sandbox 'docker' (default hivefloor-agent:1, built on first use). */
  sandboxImage?: string;
  createdAt: number;
}

export interface AgentState {
  status: AgentStatus;
  station: Station;
  note: string;
  lastActivity: number;
  pid?: number;
  /** Effective directory after worktree setup. */
  workdir?: string;
  exitCode?: number | null;
}

export type SpeechAct = 'request' | 'inform' | 'query' | 'propose' | 'agree' | 'refuse' | 'done';

export interface HiveMessage {
  id: string;
  conv: string;
  replyTo: string | null;
  from: string;
  to: string;
  act: SpeechAct;
  subject: string;
  body: string;
  hops: number;
  createdAt: number;
  readAt?: number;
}

export type TaskStatus = 'queued' | 'active' | 'blocked' | 'done' | 'failed';

export interface Task {
  id: string;
  title: string;
  spec: string;
  assignee: string | null;
  createdBy: string;
  status: TaskStatus;
  result?: string;
  /** Approval id that pre-authorises this task (human already said yes). */
  approval?: string;
  createdAt: number;
  updatedAt: number;
}

export type ApprovalKind = 'spend' | 'delete' | 'big-change' | 'external' | 'other';
export type ApprovalStatus = 'pending' | 'approved' | 'denied';

export interface Approval {
  id: string;
  agent: string;
  kind: ApprovalKind;
  summary: string;
  detail: string;
  status: ApprovalStatus;
  createdAt: number;
  decidedAt?: number;
  reason?: string;
}

export interface MemoryEntry {
  id: string;
  agent: string;
  scope: 'private' | 'shared';
  text: string;
  tags: string[];
  createdAt: number;
}

export interface Lease {
  path: string;
  agent: string;
  expiresAt: number;
}

/** Event-sourced mutations. Every state change in the hive is one of these. */
export type HiveEvent =
  | { t: 'agent.add'; spec: AgentSpec }
  | { t: 'agent.update'; id: string; patch: Partial<AgentSpec> }
  | { t: 'agent.remove'; id: string }
  | { t: 'msg.send'; msg: HiveMessage }
  | { t: 'msg.read'; agent: string; ids: string[]; at: number }
  | { t: 'task.put'; task: Task }
  | { t: 'approval.put'; approval: Approval }
  | { t: 'memory.add'; entry: MemoryEntry }
  | { t: 'memory.remove'; id: string }
  | { t: 'board.set'; text: string; by: string };

export interface SequencedEvent {
  seq: number;
  at: number;
  ev: HiveEvent;
}

/** Ephemeral (non-persisted) signals, used to drive the UI. */
export type LiveSignal =
  | { t: 'agent.state'; id: string; state: AgentState }
  | { t: 'lease.change'; leases: Lease[] }
  | { t: 'log'; level: 'info' | 'warn' | 'error'; text: string; agent?: string };

export interface HiveSnapshot {
  seq: number;
  agents: Record<string, AgentSpec>;
  messages: HiveMessage[];
  tasks: Record<string, Task>;
  approvals: Record<string, Approval>;
  memory: MemoryEntry[];
  board: string;
}

export const HUMAN = 'human';
export const BOSS_ALIAS = 'boss';
export const BROADCAST = 'all';
