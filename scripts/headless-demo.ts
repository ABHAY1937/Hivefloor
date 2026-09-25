// Headless demo: runs the whole office in your terminal (no Electron). Boots a boss
// + 4 workers as real PTY processes, sends two requests, auto-approves the risky
// one, and prints the live timeline. `npm run demo:headless`
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../src/core/harness';

const C = { d: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', red: '\x1b[31m' };
const t0 = Date.now();
const ts = () => `${C.d}${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s${C.r}`;

(async () => {
  const home = process.env.HIVEFLOOR_HOME || mkdtempSync(join(tmpdir(), 'hivefloor-demo-'));
  const h = new Harness({ home, agentsDir: join(__dirname, '../resources/agents'), simSpeed: Number(process.env.SPEED || 2) });
  await h.start();
  const agents = h.seedOffice('sim', join(home, 'workspace'));
  console.log(`${C.b}Hivefloor headless demo${C.r} — home ${home}`);
  console.log(`terminal backend: ${h.pty.backend}; control server ${h.server.url}\n`);
  const name = (id: string) => (id === 'human' ? 'YOU' : h.hive.getAgent(id)?.name ?? id);

  h.bus.on('hive', ({ ev }) => {
    if (ev.t === 'msg.send') {
      const m = ev.msg;
      const col = m.to === 'human' ? C.c : m.from === 'human' ? C.y : C.d;
      console.log(`${ts()} ${col}✉ ${name(m.from)} → ${name(m.to)} [${m.act}] ${m.subject}${C.r}`);
    } else if (ev.t === 'task.put') {
      const t = ev.task;
      const col = t.status === 'done' ? C.g : t.status === 'failed' ? C.red : C.m;
      console.log(`${ts()} ${col}▣ task ${t.status.padEnd(6)} ${name(t.assignee ?? '-')}: ${t.title}${C.r}`);
    } else if (ev.t === 'memory.add') {
      console.log(`${ts()} ${C.d}📓 ${name(ev.entry.agent)} remembered${ev.entry.scope === 'shared' ? ' (shared)' : ''}: ${ev.entry.text.slice(0, 90)}${C.r}`);
    } else if (ev.t === 'approval.put') {
      const a = ev.approval;
      console.log(`${ts()} ${C.y}${C.b}⚠ approval ${a.status}: [${a.kind}] ${a.summary} (from ${name(a.agent)})${C.r}`);
      if (a.status === 'pending') {
        setTimeout(() => {
          console.log(`${ts()} ${C.y}  → you click Approve${C.r}`);
          h.hive.decide(a.id, true, 'go ahead');
        }, 1500);
      }
    }
  });
  h.hive.bus.on('leases', (ls) => ls.length && console.log(`${ts()} ${C.d}🔒 leases: ${ls.map((l) => `${l.path}→${name(l.agent)}`).join(', ')}${C.r}`));

  for (const a of agents) await h.startAgent(a.id);
  await new Promise((r) => setTimeout(r, 1500));
  console.log(`\n${ts()} ${C.b}You → boss:${C.r} "Add a login endpoint to the API and build a dashboard page for it, then write regression tests"\n`);
  h.tellBoss('Add a login endpoint to the API and build a dashboard page for it, then write regression tests');

  const waitDone = (n: number) =>
    new Promise<void>((res) => {
      const iv = setInterval(() => {
        if (h.hive.listTasks().filter((t) => t.status === 'done' || t.status === 'failed').length >= n) {
          clearInterval(iv);
          res();
        }
      }, 200);
    });
  await waitDone(3);
  await new Promise((r) => setTimeout(r, 800));
  console.log(`\n${ts()} ${C.b}You → boss:${C.r} "Deploy the dashboard to production"  (needs approval)\n`);
  h.tellBoss('Deploy the dashboard to production');
  await waitDone(4);
  await new Promise((r) => setTimeout(r, 1500));

  console.log(`\n${C.b}Summary${C.r}`);
  for (const t of h.hive.listTasks().reverse()) console.log(`  ${t.status === 'done' ? C.g + '✓' : C.red + '✗'}${C.r} ${name(t.assignee ?? '-').padEnd(6)} ${t.title}`);
  console.log(`  messages: ${h.hive.recentMessages(10_000).length}, memories: ${h.hive.memory.size}, approvals: ${h.hive.listApprovals().length}, control-server requests: ${h.server.requests}`);
  console.log(`\n${C.b}Recall "dashboard" (as Lin):${C.r}`);
  for (const hit of h.hive.memory.recall('dashboard', { agent: 'lin', limit: 3 })) console.log(`  - ${hit.entry.text}`);
  console.log(`\nLin's terminal (last lines):${C.d}`);
  console.log(h.pty.replay('lin').split(/\r?\n/).slice(-12).join('\n') + C.r);
  await h.stop();
  console.log(`\nState persisted in ${home}/hive (events.jsonl, state.json, agents/*/memory.md). Run again with HIVEFLOOR_HOME=${home} to see memory survive.`);
  process.exit(0);
})();
