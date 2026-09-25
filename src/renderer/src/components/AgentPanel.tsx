import { useMemo, useState } from 'react';
import { call, select, useStore } from '../store';
import { MemoryList } from './MemoryPanel';
import { Portrait, StatusDot, ago, useAgentName, Empty } from './common';
import { TerminalView } from './TerminalView';

type Sub = 'terminal' | 'memory' | 'messages' | 'setup';

export function AgentPanel({ id }: { id: string }) {
  const agent = useStore((s) => s.agents[id]);
  const state = useStore((s) => s.states[id]);
  const leases = useStore((s) => s.leases);
  const [sub, setSub] = useState<Sub>('terminal');
  if (!agent) return <Empty title="Agent not found" />;
  const running = state && !['offline', 'error'].includes(state.status);
  const myLeases = leases.filter((l) => l.agent === id);

  return (
    <div className="agent-panel">
      <div className="agent-head">
        <Portrait agent={agent} size={40} />
        <div className="agent-meta">
          <div className="agent-name">
            {agent.name} {agent.isBoss && <span className="tag gold">boss</span>}
            <span className="tag">{agent.provider}{agent.model ? ` · ${agent.model}` : ''}</span>
            {agent.isolation === 'worktree' && <span className="tag">worktree</span>}
          </div>
          <div className="agent-role">
            <StatusDot status={state?.status ?? 'offline'} /> {state?.status ?? 'offline'} — {state?.note || agent.role}
          </div>
          {myLeases.length > 0 && <div className="agent-leases">🔒 {myLeases.map((l) => l.path).join(', ')}</div>}
        </div>
        <div className="agent-actions">
          {running ? (
            <>
              <button className="ghost small" onClick={() => void call('restart', id)}>Restart</button>
              <button className="ghost small" onClick={() => void call('stop', id)}>Stop</button>
            </>
          ) : (
            <button className="primary small" onClick={() => void call('start', id)}>Start</button>
          )}
          <button className="ghost small icon" title="Close" onClick={() => select(null)}>✕</button>
        </div>
      </div>
      <div className="subtabs">
        {(['terminal', 'memory', 'messages', 'setup'] as Sub[]).map((s) => (
          <button key={s} className={sub === s ? 'active' : ''} onClick={() => setSub(s)}>
            {s}
          </button>
        ))}
      </div>
      <div className="agent-body">
        {sub === 'terminal' && (running ? <TerminalView id={id} /> : <Empty title="Not running" hint={state?.note || 'Start the agent to open its terminal.'} />)}
        {sub === 'memory' && <MemoryList agent={id} />}
        {sub === 'messages' && <AgentMessages id={id} />}
        {sub === 'setup' && <AgentSetup id={id} />}
      </div>
    </div>
  );
}

function AgentMessages({ id }: { id: string }) {
  const messages = useStore((s) => s.messages);
  const name = useAgentName();
  const [text, setText] = useState('');
  const list = useMemo(() => messages.filter((m) => m.from === id || m.to === id || m.to === 'all').slice(-150).reverse(), [messages, id]);
  return (
    <div className="msgs">
      <form
        className="composer inline"
        onSubmit={(e) => {
          e.preventDefault();
          if (!text.trim()) return;
          void call('sendAsHuman', id, text.split('\n')[0].slice(0, 120), text);
          setText('');
        }}
      >
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={`Direct message to ${name(id)} (bypasses the boss)`} />
        <button className="ghost" type="submit">Send</button>
      </form>
      {list.length === 0 && <Empty title="No messages yet" />}
      {list.map((m) => (
        <div key={m.id} className={`msg ${m.readAt ? '' : 'unread'}`}>
          <div className="msg-top">
            <b>{name(m.from)}</b> → <b>{name(m.to)}</b> <span className={`act act-${m.act}`}>{m.act}</span>
            <span className="muted"> · {ago(m.createdAt)}{m.hops ? ` · hop ${m.hops}` : ''}</span>
          </div>
          <div className="msg-subject">{m.subject}</div>
          {m.body && <div className="msg-body">{m.body}</div>}
        </div>
      ))}
    </div>
  );
}

function AgentSetup({ id }: { id: string }) {
  const agent = useStore((s) => s.agents[id]);
  const providers = useStore((s) => s.providers);
  const [f, setF] = useState({ ...agent, skills: agent.skills.join(', ') });
  const [saved, setSaved] = useState(false);
  const save = async (restart: boolean) => {
    await call('updateAgent', id, {
      name: f.name,
      role: f.role,
      provider: f.provider,
      model: f.model || undefined,
      skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean),
      cwd: f.cwd,
      isolation: f.isolation,
      command: f.command || undefined
    });
    if (restart) await call('restart', id);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <div className="form">
      <label>Name<input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
      <label>Role<input value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })} /></label>
      <label>Skills (used for routing)<input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} /></label>
      <label>
        Engine
        <select value={f.provider} onChange={(e) => setF({ ...f, provider: e.target.value })}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
        </select>
        <span className="hint">{providers.find((p) => p.id === f.provider)?.describe}</span>
      </label>
      <label>Model (optional)<input value={f.model ?? ''} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder="provider default" /></label>
      {f.provider === 'custom' && <label>Command<input value={f.command ?? ''} onChange={(e) => setF({ ...f, command: e.target.value })} /></label>}
      <label>
        Working folder
        <div className="row">
          <input value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })} />
          <button type="button" className="ghost" onClick={async () => { const p = await call<string | null>('pickFolder'); if (p) setF({ ...f, cwd: p }); }}>Browse</button>
        </div>
      </label>
      <label>
        Isolation
        <select value={f.isolation} onChange={(e) => setF({ ...f, isolation: e.target.value as 'shared' | 'worktree' })}>
          <option value="shared">Shared folder (use file leases)</option>
          <option value="worktree">Own git worktree + branch</option>
        </select>
      </label>
      <div className="row end">
        {saved && <span className="ok">Saved</span>}
        <button className="danger ghost" onClick={() => { if (confirm(`Remove ${agent.name} from the office? Their memory stays in the hive.`)) void call('fire', id).then(() => select(null)); }}>Remove agent</button>
        <button className="ghost" onClick={() => void save(false)}>Save</button>
        <button className="primary" onClick={() => void save(true)}>Save & restart</button>
      </div>
    </div>
  );
}
