import { useMemo, useState } from 'react';
import type { Task, TaskStatus } from '../../../core/types';
import { call, select, useStore } from '../store';
import { Portrait, ago, useAgentName, Empty } from './common';

const KIND_LABEL: Record<string, string> = {
  spend: '💳 Spend',
  delete: '🗑 Delete',
  'big-change': '🏗 Big change',
  external: '📣 External',
  other: '❔ Other'
};

export function ApprovalsPanel() {
  const approvals = useStore((s) => s.approvals);
  const agents = useStore((s) => s.agents);
  const name = useAgentName();
  const [notes, setNotes] = useState<Record<string, string>>({});
  const all = Object.values(approvals).sort((a, b) => b.createdAt - a.createdAt);
  const pending = all.filter((a) => a.status === 'pending');
  const done = all.filter((a) => a.status !== 'pending').slice(0, 50);
  return (
    <div className="scroll pad">
      <div className="section-title">Waiting for you ({pending.length})</div>
      {pending.length === 0 && <Empty title="Nothing needs your approval" hint="Agents escalate only spending, deletions, big changes and external communication." />}
      {pending.map((a) => (
        <div key={a.id} className="card approval">
          <div className="card-top">
            <span className={`kind kind-${a.kind}`}>{KIND_LABEL[a.kind]}</span>
            <Portrait agent={agents[a.agent]} size={20} />
            <span className="muted">{name(a.agent)} · {ago(a.createdAt)}</span>
          </div>
          <div className="card-title">{a.summary}</div>
          {a.detail && <pre className="card-detail">{a.detail}</pre>}
          <input
            placeholder="Optional note to the agent…"
            value={notes[a.id] ?? ''}
            onChange={(e) => setNotes({ ...notes, [a.id]: e.target.value })}
          />
          <div className="row end">
            <button className="danger" onClick={() => void call('decide', a.id, false, notes[a.id] ?? '')}>Deny</button>
            <button className="primary" onClick={() => void call('decide', a.id, true, notes[a.id] ?? '')}>Approve</button>
          </div>
        </div>
      ))}
      {done.length > 0 && <div className="section-title">History</div>}
      {done.map((a) => (
        <div key={a.id} className="card compact">
          <span className={`pill ${a.status}`}>{a.status}</span> <span className="muted">{KIND_LABEL[a.kind]} · {name(a.agent)} · {ago(a.decidedAt ?? a.createdAt)}</span>
          <div>{a.summary}</div>
          {a.reason && <div className="muted small">Note: {a.reason}</div>}
        </div>
      ))}
    </div>
  );
}

const COLS: { key: TaskStatus; label: string }[] = [
  { key: 'queued', label: 'Queued' },
  { key: 'active', label: 'In progress' },
  { key: 'blocked', label: 'Blocked' },
  { key: 'done', label: 'Done' },
  { key: 'failed', label: 'Failed' }
];

export function TasksPanel() {
  const tasks = useStore((s) => s.tasks);
  const agents = useStore((s) => s.agents);
  const board = useStore((s) => s.board);
  const name = useAgentName();
  const [open, setOpen] = useState<Task | null>(null);
  const by = useMemo(() => {
    const m: Record<string, Task[]> = {};
    for (const t of Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt)) (m[t.status] ??= []).push(t);
    return m;
  }, [tasks]);
  const cols = COLS.filter((c) => c.key !== 'blocked' && c.key !== 'failed' || (by[c.key]?.length ?? 0) > 0);
  return (
    <div className="scroll pad">
      {Object.keys(tasks).length === 0 && <Empty title="No tasks yet" hint="Ask the boss for something — tasks appear here as they're routed." />}
      <div className="kanban" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
        {cols.map((c) => (
          <div key={c.key} className="kcol">
            <div className="kcol-head">{c.label} <span className="muted">{by[c.key]?.length ?? 0}</span></div>
            {(by[c.key] ?? []).slice(0, 40).map((t) => (
              <button key={t.id} className={`kcard st-${t.status}`} onClick={() => setOpen(open?.id === t.id ? null : t)}>
                <div className="kcard-title">{t.title}</div>
                <div className="kcard-meta">
                  {t.assignee && <Portrait agent={agents[t.assignee]} size={16} />} {t.assignee ? name(t.assignee) : 'unassigned'} · {ago(t.updatedAt)}
                </div>
                {open?.id === t.id && (
                  <div className="kcard-more">
                    {t.spec && <div><b>Spec:</b> {t.spec}</div>}
                    {t.result && <div><b>Result:</b> {t.result}</div>}
                    <div className="muted">by {name(t.createdBy)} · {t.id}</div>
                    {t.assignee && <span className="link" onClick={(e) => { e.stopPropagation(); select(t.assignee); }}>open {name(t.assignee)} →</span>}
                  </div>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className="section-title">Shared plan (blackboard)</div>
      <pre className="board">{board || 'Empty. The boss writes the plan here as work is routed.'}</pre>
    </div>
  );
}

export function ActivityPanel() {
  const activity = useStore((s) => s.activity);
  const agents = useStore((s) => s.agents);
  const [filter, setFilter] = useState<string>('');
  const list = activity.filter((a) => !filter || a.kind === filter).slice().reverse();
  return (
    <div className="scroll pad">
      <div className="row">
        {['', 'msg', 'task', 'approval', 'memory', 'agent', 'log'].map((k) => (
          <button key={k} className={`chip ${filter === k ? 'on' : ''}`} onClick={() => setFilter(k)}>{k || 'all'}</button>
        ))}
      </div>
      {list.length === 0 && <Empty title="Quiet so far" />}
      {list.map((a, i) => (
        <div key={i} className={`feed feed-${a.kind}`}>
          <Portrait agent={a.agent ? agents[a.agent] : undefined} size={18} />
          <span className="feed-text">{a.text}</span>
          <span className="muted small">{ago(a.at)}</span>
        </div>
      ))}
    </div>
  );
}
