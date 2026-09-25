import { useEffect, useMemo, useRef, useState } from 'react';
import { call, select, store, useStore } from '../store';
import { Portrait, ago, useAgentName, Empty } from './common';

const SUGGESTIONS = [
  'Add a login endpoint to the API and build a dashboard page for it',
  'Write regression tests for the auth flow',
  'Set up a CI pipeline with Docker',
  'Deploy the dashboard to production',
  'Buy a GPU cluster for $900 for load testing'
];

export function BossChat() {
  const agents = useStore((s) => s.agents);
  const messages = useStore((s) => s.messages);
  const approvals = useStore((s) => s.approvals);
  const states = useStore((s) => s.states);
  const name = useAgentName();
  const boss = Object.values(agents).find((a) => a.isBoss);
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  const list = useRef<HTMLDivElement>(null);

  const thread = useMemo(
    () => (boss ? messages.filter((m) => (m.from === 'human' && m.to === boss.id) || m.to === 'human') : []),
    [messages, boss]
  );
  const pending = Object.values(approvals).filter((a) => a.status === 'pending');

  useEffect(() => {
    list.current?.scrollTo({ top: list.current.scrollHeight, behavior: 'smooth' });
  }, [thread.length]);

  const send = async (t = text) => {
    if (!t.trim()) return;
    setErr('');
    try {
      await call('tellBoss', t.trim());
      setText('');
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };

  if (!boss) return <Empty title="No boss yet" hint="Hire an agent and tick “boss” — it's the one you talk to." />;
  const bossState = states[boss.id];

  return (
    <div className="chat">
      <div className="chat-head">
        <Portrait agent={boss} size={34} />
        <div>
          <div className="chat-title">{boss.name}</div>
          <div className="chat-sub">
            {bossState?.status === 'working' ? 'working…' : bossState?.note || bossState?.status} · routes work, asks you only for approvals
          </div>
        </div>
        <button className="ghost small" onClick={() => select(boss.id)}>Open terminal</button>
      </div>
      {pending.length > 0 && (
        <button className="banner" onClick={() => store.set({ tab: 'approvals' })}>
          {pending.length} approval{pending.length > 1 ? 's' : ''} waiting for you →
        </button>
      )}
      <div className="chat-list" ref={list}>
        {thread.length === 0 && (
          <div className="chat-empty">
            <p>Tell {boss.name} what you need. They'll split it into tasks, route them to the right people, and only come back to you for money, deletions or big changes.</p>
            <div className="chips">
              {SUGGESTIONS.map((s) => (
                <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          </div>
        )}
        {thread.map((m) => {
          const mine = m.from === 'human';
          return (
            <div key={m.id} className={`bubble-row ${mine ? 'mine' : ''}`}>
              {!mine && <Portrait agent={agents[m.from]} size={24} />}
              <div className={`bubble act-${m.act}`}>
                {!mine && <div className="bubble-from">{name(m.from)}</div>}
                <div className="bubble-subject">{m.subject}</div>
                {m.body && m.body !== m.subject && <div className="bubble-body">{m.body}</div>}
                <div className="bubble-time">{ago(m.createdAt)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {thread.length > 0 && (
        <div className="chips compact">
          {SUGGESTIONS.slice(1, 5).map((s) => (
            <button key={s} className="chip" onClick={() => void send(s)}>{s}</button>
          ))}
        </div>
      )}
      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <textarea
          value={text}
          placeholder={`Message ${boss.name}…  (Enter to send, Shift+Enter for a new line)`}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
        />
        <button className="primary" type="submit" disabled={!text.trim()}>Send</button>
      </form>
      {err && <div className="error">{err}</div>}
    </div>
  );
}
