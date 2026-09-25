import { randomBytes } from 'node:crypto';
import { promises as fsp, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let lastMs = 0;
let counter = 0;

/** Time-sortable, collision-safe id: <base36 ms><counter><random>. */
export function newId(prefix = ''): string {
  const now = Date.now();
  if (now === lastMs) counter++;
  else {
    lastMs = now;
    counter = 0;
  }
  return `${prefix}${now.toString(36)}${counter.toString(36).padStart(2, '0')}${randomBytes(3).toString('hex')}`;
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'agent';
}

/** Atomic write: temp file + rename, so readers never see a torn file. */
export async function writeAtomic(path: string, data: string): Promise<void> {
  await fsp.mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fsp.writeFile(tmp, data, 'utf8');
  await fsp.rename(tmp, path);
}

export function writeAtomicSync(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

/** Trailing-edge debounce that can also be flushed synchronously on shutdown. */
export function debounce<T extends () => unknown>(fn: T, ms: number): { (): void; flush(): void; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  const run = (() => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    timer.unref?.();
  }) as { (): void; flush(): void; cancel(): void };
  run.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn();
    }
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return run;
}

/** Leading-scheduled throttle: runs once `ms` after the first call in a window. */
export function throttle<T extends () => unknown>(fn: T, ms: number): { (): void; flush(): void; cancel(): void } {
  let timer: NodeJS.Timeout | null = null;
  const run = (() => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    timer.unref?.();
  }) as { (): void; flush(): void; cancel(): void };
  run.flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
      fn();
    }
  };
  run.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return run;
}

export function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}
