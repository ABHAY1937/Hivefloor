import { useEffect, useRef, useState } from 'react';
import { Floor } from './floor/Floor';
import { store, useStore, select, type PanelTab } from './store';
import { AgentPanel } from './components/AgentPanel';
import { BossChat } from './components/BossChat';
import { MemoryList } from './components/MemoryPanel';
import { ActivityPanel, ApprovalsPanel, TasksPanel } from './components/Panels';
import { HireModal, SettingsModal } from './components/Modals';
import { Portrait, StatusDot } from './components/common';

export function App() {
  const ready = useStore((s) => s.ready);
  const modal = useStore((s) => s.modal);
  const [panelW, setPanelW] = useState(() => Math.round(window.innerWidth * 0.42));
  const dragging = useRef(false);

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (dragging.current) setPanelW(Math.max(380, Math.min(window.innerWidth - 480, window.innerWidth - e.clientX)));
    };
    const up = () => (dragging.current = false);
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  }, []);

  if (!ready) return <div className="boot">Opening the office…</div>;
  return (
    <div className="app">
      <TopBar />
      <div className="main">
        <div className="left">
          <Floor />
          <Roster />
        </div>
        <div className="splitter" onMouseDown={() => (dragging.current = true)} />
        <div className="right" style={{ width: panelW }}>
          <SidePanel />
        </div>
      </div>
      {modal === 'hire' && <HireModal />}
      {modal === 'settings' && <SettingsModal />}
    </div>
  );
}

function TopBar() {
  const agents = useStore((s) => s.agents);
  const states = useStore((s) => s.states);
  const approvals = useStore((s) => s.approvals);
  const tasks = useStore((s) => s.tasks);
  const pending = Object.values(approvals).filter((a) => a.status === 'pending').length;
  const working = Object.values(states).filter((s) => s.status === 'working').length;
  const activeTasks = Object.values(tasks).filter((t) => t.status === 'active').length;
  return (
    <div className="topbar">
      <div className="brand">
        <span className="logo">▦</span> Hivefloor
      </div>
      <div className="stats">
        <span><b>{Object.keys(agents).length}</b> agents</span>
        <span><b className="green">{working}</b> working</span>
        <span><b>{activeTasks}</b> active tasks</span>
        <button className={`approvals-btn ${pending ? 'hot' : ''}`} onClick={() => store.set({ tab: 'approvals' })}>
          {pending ? `⚠ ${pending} need${pending === 1 ? 's' : ''} approval` : '✓ no approvals pending'}
        </button>
      </div>
      <div className="top-actions">
        <button className="primary" onClick={() => store.set({ modal: 'hire' })}>+ Hire agent</button>
        <button className="ghost" onClick={() => store.set({ modal: 'settings' })}>Settings</button>
      </div>
    </div>
  );
}

function Roster() {
  const agents = useStore((s) => s.agents);
  const states = useStore((s) => s.states);
  const selected = useStore((s) => s.selected);
  const list = Object.values(agents).sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.createdAt - b.createdAt);
  return (
    <div className="roster">
      {list.map((a) => {
        const st = states[a.id];
        return (
          <button key={a.id} className={`roster-item ${selected === a.id ? 'on' : ''}`} onClick={() => select(a.id)}>
            <Portrait agent={a} size={26} />
            <div className="roster-text">
              <div className="roster-name"><StatusDot status={st?.status ?? 'offline'} /> {a.name}{a.isBoss ? ' ★' : ''}</div>
              <div className="roster-note">{st?.note || a.role}</div>
            </div>
          </button>
        );
      })}
    </div>
  );
}

const TABS: { key: PanelTab; label: string }[] = [
  { key: 'boss', label: 'Boss' },
  { key: 'agent', label: 'Agent' },
  { key: 'approvals', label: 'Approvals' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'memory', label: 'Memory' },
  { key: 'activity', label: 'Activity' }
];

function SidePanel() {
  const tab = useStore((s) => s.tab);
  const selected = useStore((s) => s.selected);
  const agents = useStore((s) => s.agents);
  const pending = useStore((s) => Object.values(s.approvals).filter((a) => a.status === 'pending').length);
  return (
    <div className="panel">
      <div className="tabs">
        {TABS.map((t) =>
          t.key === 'agent' && !selected ? null : (
            <button key={t.key} className={tab === t.key ? 'active' : ''} onClick={() => store.set({ tab: t.key })}>
              {t.key === 'agent' && selected ? agents[selected]?.name ?? 'Agent' : t.label}
              {t.key === 'approvals' && pending > 0 && <span className="badge">{pending}</span>}
            </button>
          )
        )}
      </div>
      <div className="panel-body">
        {tab === 'boss' && <BossChat />}
        {tab === 'agent' && selected && <AgentPanel key={selected} id={selected} />}
        {tab === 'approvals' && <ApprovalsPanel />}
        {tab === 'tasks' && <TasksPanel />}
        {tab === 'memory' && <div className="scroll pad"><MemoryList /></div>}
        {tab === 'activity' && <ActivityPanel />}
      </div>
    </div>
  );
}
