// Benchmarks Hivefloor's harness against a faithful re-implementation of the
// reference design's hot paths (munder-difflin src/main/hive.ts + pty.ts):
//   - router: agents drop JSON into outbox/, a 1500ms setInterval scans every
//     outbox, moves files to inbox/, then runs `git add -A && git commit` via
//     spawnSync on the main thread (with index.lock retries);
//   - PTY: one IPC send per node-pty onData chunk.
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { Harness } from '../src/core/harness';
import { MemoryIndex } from '../src/core/memory';
import { PtyManager } from '../src/core/pty';

const pct = (a: number[], p: number) => {
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};
const fmt = (n: number) => (n < 1 ? n.toFixed(3) : n < 100 ? n.toFixed(1) : Math.round(n).toString());
const results: Record<string, Record<string, string>> = {};

async function benchReferenceRouter(n: number) {
  const root = mkdtempSync(join(tmpdir(), 'ref-hive-'));
  spawnSync('git', ['init', '-q', root]);
  spawnSync('git', ['-C', root, 'config', 'user.email', 'b@b']);
  spawnSync('git', ['-C', root, 'config', 'user.name', 'bench']);
  const agents = ['a', 'b', 'c', 'd', 'e'];
  for (const a of agents) {
    mkdirSync(join(root, 'agents', a, 'outbox', '.sent'), { recursive: true });
    mkdirSync(join(root, 'agents', a, 'inbox'), { recursive: true });
  }
  const sentAt = new Map<string, number>();
  const lat: number[] = [];
  let commitMs = 0;
  let commits = 0;
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  const routeOnce = () => {
    let routed = 0;
    for (const id of readdirSync(join(root, 'agents'))) {
      const outbox = join(root, 'agents', id, 'outbox');
      for (const f of readdirSync(outbox)) {
        if (!f.endsWith('.json')) continue;
        const msg = JSON.parse(readFileSync(join(outbox, f), 'utf8'));
        writeFileSync(join(root, 'agents', msg.to, 'inbox', f), JSON.stringify(msg));
        renameSync(join(outbox, f), join(outbox, '.sent', f));
        lat.push(performance.now() - sentAt.get(msg.id)!);
        routed++;
      }
    }
    if (routed) {
      const t0 = performance.now();
      spawnSync('git', ['-C', root, 'add', '-A']);
      spawnSync('git', ['-C', root, 'commit', '-q', '-m', `routed ${routed}`]);
      commitMs += performance.now() - t0;
      commits++;
    }
  };
  const timer = setInterval(routeOnce, 1500);
  // Senders: messages spread over ~6s like a busy office.
  for (let i = 0; i < n; i++) {
    const from = agents[i % 5];
    const to = agents[(i + 1) % 5];
    const id = `m${i}`;
    sentAt.set(id, performance.now());
    writeFileSync(join(root, 'agents', from, 'outbox', `${id}.json`), JSON.stringify({ id, from, to, subject: 'x' }));
    await new Promise((r) => setTimeout(r, 6000 / n));
  }
  while (lat.length < n) await new Promise((r) => setTimeout(r, 50));
  clearInterval(timer);
  h.disable();
  // Per-message commit cost (reference also commits on every direct send()).
  const single: number[] = [];
  for (let i = 0; i < 20; i++) {
    writeFileSync(join(root, `x${i}.json`), '{}');
    const t0 = performance.now();
    spawnSync('git', ['-C', root, 'add', '-A']);
    spawnSync('git', ['-C', root, 'commit', '-q', '-m', 'msg']);
    single.push(performance.now() - t0);
  }
  return { lat, commitMs, commits, maxLag: h.max / 1e6, single };
}

async function benchHivefloor(n: number) {
  const home = mkdtempSync(join(tmpdir(), 'hf-bench-'));
  const hs = new Harness({ home, agentsDir: join(__dirname, '../resources/agents') });
  await hs.start();
  const ids = ['a', 'b', 'c', 'd', 'e'].map((x) => hs.hire({ name: x, role: 'w', provider: 'sim' }).id);
  // Register tokens like real agents so we go through HTTP exactly as the CLI does.
  const tokens = ids.map((id, i) => {
    const t = `tok-${i}-${Math.random()}`;
    hs.server.register(t, id);
    return t;
  });
  const rpc = async (tok: string, method: string, params: object) => {
    const r = await fetch(`${hs.server.url}/rpc`, { method: 'POST', headers: { authorization: `Bearer ${tok}` }, body: JSON.stringify({ method, params }) });
    return (await r.json()).result;
  };
  const lat: number[] = [];
  const h = monitorEventLoopDelay({ resolution: 5 });
  h.enable();
  // Every recipient long-polls its inbox — end-to-end: sender HTTP → hive → recipient wakes.
  const sentAt = new Map<string, number>();
  let received = 0;
  const loops = ids.map(async (_, i) => {
    while (received < n) {
      const msgs: { subject: string }[] = await rpc(tokens[i], 'inbox', { waitMs: 2000 });
      for (const m of msgs) {
        lat.push(performance.now() - sentAt.get(m.subject)!);
        received++;
      }
    }
  });
  const t0 = performance.now();
  for (let i = 0; i < n; i++) {
    const s = `m${i}`;
    sentAt.set(s, performance.now());
    await rpc(tokens[i % 5], 'send', { to: ids[(i + 1) % 5], subject: s });
    await new Promise((r) => setTimeout(r, 6000 / n));
  }
  await Promise.all(loops);
  h.disable();
  // Raw throughput, no pacing.
  const tp0 = performance.now();
  for (let i = 0; i < 5000; i++) hs.hive.send({ from: ids[0], to: ids[1], subject: 'x' });
  const perMsgUs = ((performance.now() - tp0) / 5000) * 1000;
  const wall = performance.now() - t0;
  await hs.stop();
  return { lat, maxLag: h.max / 1e6, perMsgUs, wall };
}

async function benchPty() {
  const sessions = 10;
  const script = `for (let i=0;i<4000;i++) process.stdout.write('line '+i+' '+'x'.repeat(60)+'\\n');`;
  const run = (batched: boolean) =>
    new Promise<{ ipc: number; bytes: number; ms: number }>((resolve) => {
      const m = new PtyManager({ frameMs: 16 });
      m.flowControl = false;
      let ipc = 0;
      let bytes = 0;
      let exited = 0;
      const t0 = performance.now();
      if (batched) m.bus.on('batch', (b) => { ipc++; for (const x of b) bytes += x.data.length; });
      else {
        // Reference behaviour: one send per onData chunk → count raw chunks.
        const np = require('node-pty');
        for (let i = 0; i < sessions; i++) {
          const p = np.spawn(process.execPath, ['-e', script], { cols: 120, rows: 30 });
          p.onData((d: string) => { ipc++; bytes += d.length; });
          p.onExit(() => { if (++exited === sessions) resolve({ ipc, bytes, ms: performance.now() - t0 }); });
        }
        return;
      }
      m.bus.on('exit', () => { if (++exited === sessions) { m.killAll(); resolve({ ipc, bytes, ms: performance.now() - t0 }); } });
      for (let i = 0; i < sessions; i++) m.spawn({ id: `s${i}`, command: process.execPath, args: ['-e', script], cwd: process.cwd(), env: process.env as Record<string, string> });
    });
  return { ref: await run(false), hf: await run(true) };
}

function benchMemory() {
  const idx = new MemoryIndex();
  // Zipf-distributed vocabulary of 4000 terms ≈ real engineering notes.
  const vocab = Array.from({ length: 4000 }, (_, i) => `w${i.toString(36)}`);
  const words = vocab;
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const zipf = () => vocab[Math.min(vocab.length - 1, Math.floor(Math.pow(rnd(), 2.2) * vocab.length))];
  const t0 = performance.now();
  for (let i = 0; i < 20000; i++) {
    const text = Array.from({ length: 18 }, zipf).join(' ') + ` note ${i}`;
    idx.add({ id: `k${i}`, agent: `a${i % 10}`, scope: i % 5 ? 'private' : 'shared', text, tags: [], createdAt: Date.now() - i * 1000 });
  }
  const build = performance.now() - t0;
  const q: number[] = [];
  for (let i = 0; i < 300; i++) {
    const s = performance.now();
    idx.recall(`${words[(i * 37) % 400]} ${words[(i * 11) % 2000]} ${words[(i * 5) % 4000]}`, { agent: `a${i % 10}` });
    q.push(performance.now() - s);
  }
  return { build, p50: pct(q, 50), p99: pct(q, 99) };
}

(async () => {
  const N = 120;
  console.log(`Router: ${N} messages between 5 agents over ~6s …`);
  const ref = await benchReferenceRouter(N);
  const hf = await benchHivefloor(N);
  results['Message delivery latency (sender → recipient)'] = {
    reference: `p50 ${fmt(pct(ref.lat, 50))} ms · p99 ${fmt(pct(ref.lat, 99))} ms`,
    hivefloor: `p50 ${fmt(pct(hf.lat, 50))} ms · p99 ${fmt(pct(hf.lat, 99))} ms (over real HTTP + long-poll)`
  };
  results['Main-thread blocking per persisted message'] = {
    reference: `${fmt(pct(ref.single, 50))} ms sync git add+commit (spawnSync)`,
    hivefloor: `${fmt(hf.perMsgUs / 1000)} ms (${fmt(hf.perMsgUs)} µs: in-memory apply + buffered WAL append)`
  };
  results['Worst event-loop stall during run'] = { reference: `${fmt(ref.maxLag)} ms`, hivefloor: `${fmt(hf.maxLag)} ms` };
  console.log('PTY: 10 sessions × 4000 lines …');
  const pty = await benchPty();
  results['PTY → UI IPC messages (10 chatty agents)'] = {
    reference: `${pty.ref.ipc} sends (one per onData chunk)`,
    hivefloor: `${pty.hf.ipc} sends (frame-coalesced, ${fmt(pty.ref.ipc / pty.hf.ipc)}× fewer) — and 0 for terminals not on screen`
  };
  const mem = benchMemory();
  results['Memory recall, 20k entries'] = {
    reference: 'external MemPalace CLI process per query (not benchmarked here)',
    hivefloor: `in-process BM25: p50 ${fmt(mem.p50)} ms · p99 ${fmt(mem.p99)} ms (index build ${fmt(mem.build)} ms)`
  };
  console.log('\n' + JSON.stringify(results, null, 2));
  const md = ['| Metric | Reference design | Hivefloor |', '|---|---|---|', ...Object.entries(results).map(([k, v]) => `| ${k} | ${v.reference} | ${v.hivefloor} |`)].join('\n');
  writeFileSync(join(__dirname, '..', 'BENCHMARKS.md'), `# Benchmarks\n\nRun with \`npm run bench\` (${new Date().toISOString().slice(0, 10)}, ${process.platform}, Node ${process.version}).\n\n${md}\n`);
  if (existsSync(join(__dirname, '..', 'BENCHMARKS.md'))) console.log('\nwrote BENCHMARKS.md');
  process.exit(0);
})();
