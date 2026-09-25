// xterm.js terminals, pooled per agent. Only the visible terminal is "watched":
// main streams its bytes; everything else is replayed from main's ring buffer
// when opened. Writes are acknowledged in batches for PTY flow control.

import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { hf } from '../api';
import { call } from '../store';

interface Entry {
  term: Terminal;
  fit: FitAddon;
  el: HTMLDivElement;
}

const pool = new Map<string, Entry>();
const pendingAcks = new Map<string, number>();
let ackTimer: number | null = null;
let wired = false;

function wire(): void {
  if (wired) return;
  wired = true;
  hf().on('hf:pty', (batch: { id: string; data: string }[]) => {
    for (const { id, data } of batch) {
      const e = pool.get(id);
      if (!e) continue;
      e.term.write(data);
      pendingAcks.set(id, (pendingAcks.get(id) ?? 0) + data.length);
    }
    if (!ackTimer)
      ackTimer = window.setTimeout(() => {
        ackTimer = null;
        void call('ack', [...pendingAcks.entries()]);
        pendingAcks.clear();
      }, 100);
  });
  hf().on('hf:exit', (e: { id: string; exitCode: number | null }) => {
    pool.get(e.id)?.term.write(`\r\n\x1b[90m[process exited with code ${e.exitCode}]\x1b[0m\r\n`);
  });
}

function entry(id: string): Entry {
  let e = pool.get(id);
  if (e) return e;
  const el = document.createElement('div');
  el.className = 'term-host';
  const term = new Terminal({
    fontFamily: '"JetBrains Mono", "Cascadia Code", Menlo, Consolas, monospace',
    fontSize: 12.5,
    lineHeight: 1.15,
    cursorBlink: true,
    scrollback: 5000,
    allowProposedApi: true,
    theme: {
      background: '#101216',
      foreground: '#d7dae0',
      cursor: '#f5b841',
      selectionBackground: '#3a4150',
      black: '#1b1d23',
      brightBlack: '#5b6270',
      red: '#e5534b',
      green: '#3ec17c',
      yellow: '#f5b841',
      blue: '#58a6ff',
      magenta: '#b58cf0',
      cyan: '#4fc6c6',
      white: '#d7dae0'
    }
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(el);
  term.onData((d) => void call('input', id, d));
  term.onResize(({ cols, rows }) => void call('resize', id, cols, rows));
  e = { term, fit, el };
  pool.set(id, e);
  return e;
}

export function TerminalView({ id }: { id: string }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    wire();
    const e = entry(id);
    host.current!.appendChild(e.el);
    let alive = true;
    // Atomically start streaming + get the replay boundary from main.
    void call<string>('watch', id).then((replay) => {
      if (!alive) return;
      e.term.reset();
      e.term.write(replay);
      requestAnimationFrame(() => {
        try {
          e.fit.fit();
        } catch {
          /* not visible yet */
        }
        e.term.focus();
      });
    });
    const ro = new ResizeObserver(() => {
      try {
        e.fit.fit();
      } catch {
        /* hidden */
      }
    });
    ro.observe(host.current!);
    return () => {
      alive = false;
      ro.disconnect();
      void call('unwatch', id);
      e.el.remove();
    };
  }, [id]);
  return <div className="terminal" ref={host} />;
}
