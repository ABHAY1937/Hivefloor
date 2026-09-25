import { useEffect, useMemo, useState } from 'react';
import type { MemoryEntry } from '../../../core/types';
import { call, useStore } from '../store';
import { Portrait, ago, useAgentName, Empty } from './common';

export function MemoryList({ agent }: { agent?: string }) {
  const memory = useStore((s) => s.memory);
  const agents = useStore((s) => s.agents);
  const name = useAgentName();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState(agent ?? '');
  const [hits, setHits] = useState<{ entry: MemoryEntry; score: number }[] | null>(null);
  const [newText, setNewText] = useState('');
  const [ms, setMs] = useState<number | null>(null);

  useEffect(() => {
    if (!q.trim()) return setHits(null);
    const h = setTimeout(async () => {
      const t0 = performance.now();
      const r = await call<{ entry: MemoryEntry; score: number }[]>('recall', q, filter || undefined);
      setMs(performance.now() - t0);
      setHits(r);
    }, 120);
    return () => clearTimeout(h);
  }, [q, filter, memory.length]);

  const list = useMemo(
    () => (hits ? hits.map((h) => h.entry) : memory.filter((m) => !filter || m.agent === filter || (agent && m.scope === 'shared')).slice(0, 300)),
    [hits, memory, filter, agent]
  );

  return (
    <div className="memory">
      <div className="memory-bar">
        <input className="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memory (BM25 recall)…" />
        {!agent && (
          <select value={filter} onChange={(e) => setFilter(e.target.value)}>
            <option value="">All agents</option>
            {Object.values(agents).map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
        )}
      </div>
      {hits && ms !== null && <div className="muted small">{hits.length} results in {ms.toFixed(1)} ms (round-trip)</div>}
      <form
        className="composer inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!newText.trim()) return;
          void call('remember', filter || agent || Object.values(agents).find((a) => a.isBoss)?.id || 'human', newText, !agent);
          setNewText('');
        }}
      >
        <input value={newText} onChange={(e) => setNewText(e.target.value)} placeholder={agent ? `Teach ${name(agent)} something…` : 'Add a shared fact every agent can recall…'} />
        <button className="ghost" type="submit">Remember</button>
      </form>
      {list.length === 0 && <Empty title="Nothing remembered yet" hint="Agents store what they learn with `hive remember`. It survives restarts." />}
      <div className="memory-list">
        {list.map((m) => (
          <div key={m.id} className="mem">
            <Portrait agent={agents[m.agent]} size={22} />
            <div className="mem-main">
              <div className="mem-text">{m.text}</div>
              <div className="mem-meta">
                {name(m.agent)} · {ago(m.createdAt)} {m.scope === 'shared' && <span className="tag">shared</span>}
                {m.tags.map((t) => <span key={t} className="tag subtle">#{t}</span>)}
              </div>
            </div>
            <button className="ghost small icon" title="Forget" onClick={() => void call('forget', m.id)}>✕</button>
          </div>
        ))}
      </div>
    </div>
  );
}
