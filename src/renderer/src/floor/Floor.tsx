import { useEffect, useRef } from 'react';
import { select, store } from '../store';
import { Scene } from './scene';

export function Floor() {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const scene = new Scene(canvas.current!);
    let last: unknown[] = [];
    const push = () => {
      const s = store.state;
      // Store slices are replaced immutably, so identity tells us what changed.
      const deps = [s.agents, s.states, s.leases, s.selected, s.messages, s.approvals];
      if (deps.every((d, i) => d === last[i])) return;
      last = deps;
      const unread: Record<string, number> = {};
      for (const m of s.messages) if (!m.readAt && m.to !== 'human') unread[m.to] = (unread[m.to] ?? 0) + 1;
      scene.update({
        agents: Object.values(s.agents).sort((a, b) => Number(b.isBoss) - Number(a.isBoss) || a.createdAt - b.createdAt),
        states: s.states,
        leases: s.leases,
        unread,
        selected: s.selected,
        pendingApprovals: Object.values(s.approvals).filter((a) => a.status === 'pending').length
      });
    };
    push();
    const unsub = store.subscribe(push);
    const unfx = store.onFx((fx) => (fx.t === 'envelope' ? scene.envelope(fx.from, fx.to, fx.act) : scene.memoryPulse(fx.agent)));
    const ro = new ResizeObserver(([e]) => scene.resize(e.contentRect.width, e.contentRect.height));
    ro.observe(wrap.current!);
    const onVis = () => !document.hidden && scene.kick();
    document.addEventListener('visibilitychange', onVis);
    const el = canvas.current!;
    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const id = scene.hit(e.clientX - r.left, e.clientY - r.top);
      if (id !== scene.hover) {
        scene.hover = id;
        el.style.cursor = id ? 'pointer' : 'default';
        scene.kick();
      }
    };
    const onClick = (e: MouseEvent) => {
      const r = el.getBoundingClientRect();
      const id = scene.hit(e.clientX - r.left, e.clientY - r.top);
      select(id);
    };
    el.addEventListener('mousemove', onMove);
    el.addEventListener('click', onClick);
    (window as unknown as { __scene: Scene }).__scene = scene;
    return () => {
      unsub();
      unfx();
      ro.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      el.removeEventListener('mousemove', onMove);
      el.removeEventListener('click', onClick);
      scene.stop();
    };
  }, []);

  return (
    <div className="floor" ref={wrap}>
      <canvas ref={canvas} />
    </div>
  );
}
