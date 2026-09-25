import { useEffect, useRef } from 'react';
import type { AgentSpec } from '../../../core/types';
import { sprite } from '../floor/sprites';
import { useStore } from '../store';

export function Portrait({ agent, size = 28 }: { agent?: AgentSpec; size?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c || !agent) return;
    const dpr = window.devicePixelRatio || 1;
    c.width = size * dpr;
    c.height = size * dpr;
    const g = c.getContext('2d')!;
    g.imageSmoothingEnabled = false;
    g.clearRect(0, 0, c.width, c.height);
    const img = sprite(agent.avatar, 'front');
    // Crop head + shoulders
    g.drawImage(img, 1, 0, 14, 16, 0, 0, c.width, (c.width * 16) / 14);
  }, [agent, size]);
  if (!agent) return <div className="portrait human" style={{ width: size, height: size }}>you</div>;
  return <canvas ref={ref} className="portrait" style={{ width: size, height: size }} />;
}

export function StatusDot({ status }: { status: string }) {
  return <span className={`dot dot-${status}`} title={status} />;
}

export function useAgentName(): (id: string) => string {
  const agents = useStore((s) => s.agents);
  return (id: string) => (id === 'human' ? 'You' : id === 'all' ? 'Everyone' : agents[id]?.name ?? id);
}

export function ago(t: number): string {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(t).toLocaleDateString();
}

export function Empty({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="empty">
      <div className="empty-title">{title}</div>
      {hint && <div className="empty-hint">{hint}</div>}
    </div>
  );
}
