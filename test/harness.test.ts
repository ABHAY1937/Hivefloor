// End-to-end: real processes in real PTYs, talking through the control server.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Harness } from '../src/core/harness';

const agentsDir = resolve(__dirname, '../resources/agents');

function until<T>(fn: () => T | undefined | false, ms = 20000): Promise<T> {
  return new Promise((res, rej) => {
    const t0 = Date.now();
    const tick = () => {
      const v = fn();
      if (v) return res(v as T);
      if (Date.now() - t0 > ms) return rej(new Error('timeout'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

test('hive CLI round-trip from inside a PTY shell', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const h = new Harness({ home, agentsDir });
  await h.start();
  h.hire({ name: 'Morgan', role: 'boss', provider: 'sim', isBoss: true });
  const cli = h.hire({ name: 'Tess', role: 'shell user', provider: 'custom', command: 'bash', args: ['--noprofile', '--norc'] });
  let out = '';
  h.bus.on('pty', (b) => b.forEach((x) => x.id === cli.id && (out += x.data)));
  await h.startAgent(cli.id);
  h.input(cli.id, 'hive remember "the deploy key is in 1password" --shared && hive send boss "need review" --body "PR 12" && echo CLI_$((40+2))_OK\n');
  await until(() => out.includes('CLI_42_OK'));
  assert.equal(h.hive.unreadCount('morgan'), 1);
  assert.equal(h.hive.inbox('morgan')[0].from, cli.id, 'sender is authenticated by token');
  assert.equal(h.hive.memory.recall('deploy key')[0].entry.scope, 'shared');
  // Policy check through the CLI
  out = '';
  h.input(cli.id, 'hive check "rm -rf /var/data" ; echo CHECK_$((1+1))_DONE\n');
  await until(() => out.includes('CHECK_2_DONE'));
  assert.match(out, /NEEDS APPROVAL \(delete\)/);
  await h.stop();
});

test('demo office: boss routes a human request to workers who finish it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const workspace = join(home, 'workspace');
  const h = new Harness({ home, agentsDir, simSpeed: 8 });
  await h.start();
  h.seedOffice('sim', workspace);
  for (const a of h.hive.listAgents()) await h.startAgent(a.id);
  await until(() => h.hive.listAgents().every((a) => h.state(a.id).note.length > 0 && h.state(a.id).status === 'idle'));

  h.tellBoss('Add a login endpoint to the API and build a dashboard page for it');
  const done = await until(() => h.hive.recentMessages().find((m) => m.to === 'human' && m.act === 'done'), 30000);
  assert.match(done.subject, /done/i);
  const tasks = h.hive.listTasks();
  assert.equal(tasks.length, 2);
  assert.ok(tasks.every((t) => t.status === 'done'));
  assert.deepEqual(new Set(tasks.map((t) => t.assignee)), new Set(['ada', 'lin']));
  // Real files written in the workspace, memories stored.
  assert.ok(existsSync(join(workspace, 'src/api/auth.ts')));
  assert.match(readFileSync(join(workspace, 'src/ui/Dashboard.tsx'), 'utf8'), /Lin:/);
  assert.ok(h.hive.memory.recall('dashboard', { agent: 'lin' }).length > 0);
  // Peer-to-peer message happened (frontend asked backend).
  assert.ok(h.hive.recentMessages().some((m) => m.from === 'lin' && m.to === 'ada' && m.act === 'query'));

  // Risky request → approval queue, nothing happens until human decides.
  h.tellBoss('Buy a GPU cluster for $900 for load testing');
  const ap = await until(() => h.hive.listApprovals('pending')[0], 10000);
  assert.equal(ap.kind, 'spend');
  const before = h.hive.listTasks().length;
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.hive.listTasks().length, before, 'no work dispatched before approval');
  h.hive.decide(ap.id, false, 'too expensive');
  await until(() => h.hive.recentMessages().find((m) => m.to === 'human' && /won't do/.test(m.subject)), 10000);

  // Approved risky request: tasks carry the approval, so workers don't ask twice.
  h.tellBoss('Deploy the dashboard to production');
  const ap2 = await until(() => h.hive.listApprovals('pending')[0], 10000);
  h.hive.decide(ap2.id, true);
  const deploy = await until(() => h.hive.listTasks().find((t) => /production/.test(t.title) && t.status === 'done'), 20000);
  assert.equal(deploy.approval, ap2.id);
  assert.equal(deploy.assignee, 'rio', 'deploy work routed to DevOps');
  assert.equal(h.hive.listApprovals().filter((a) => a.summary.includes('production')).length, 1, 'asked exactly once');
  await h.stop();
});

test('worktree isolation gives each worker its own branch', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const repo = join(home, 'repo');
  execFileSync('git', ['init', '-q', repo]);
  execFileSync('git', ['-C', repo, '-c', 'user.email=a@b', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init']);
  const h = new Harness({ home, agentsDir });
  await h.start();
  const a = h.hire({ name: 'Ada', role: 'dev', provider: 'custom', command: 'bash', args: ['--noprofile', '--norc'], cwd: repo, isolation: 'worktree' });
  await h.startAgent(a.id);
  const wd = h.state(a.id).workdir!;
  assert.notEqual(wd, repo);
  assert.equal(execFileSync('git', ['-C', wd, 'branch', '--show-current']).toString().trim(), 'hive/ada');
  await h.stop();
});

test('built-in LLM agent drives tools via an OpenAI-compatible endpoint (mock local model)', async () => {
  const { createServer } = await import('node:http');
  let calls = 0;
  const srv = createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    const parsed = JSON.parse(body);
    calls++;
    const lastTool = parsed.messages.filter((m: { role: string }) => m.role === 'tool').length;
    const message =
      lastTool === 0
        ? { role: 'assistant', content: 'Saving that.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'hive_remember', arguments: JSON.stringify({ text: 'Staging runs on port 5433', shared: true }) } }] }
        : lastTool === 1
          ? { role: 'assistant', content: '', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'run_shell', arguments: JSON.stringify({ command: 'rm -rf ./data' }) } }] }
          : { role: 'assistant', content: 'All set.' };
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message }] }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const port = (srv.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const h = new Harness({ home, agentsDir, llm: { baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock' } });
  await h.start();
  const a = h.hire({ name: 'Local', role: 'dev', provider: 'hive-llm' });
  let out = '';
  h.bus.on('pty', (b) => b.forEach((x) => (out += x.data)));
  await h.startAgent(a.id);
  await until(() => out.includes('Type here'));
  h.hive.send({ from: 'human', to: a.id, subject: 'remember the staging port, then clean data' });
  const ap = await until(() => h.hive.listApprovals('pending')[0], 15000);
  assert.equal(ap.kind, 'delete', 'rm -rf held for approval, not executed');
  assert.equal(h.hive.memory.recall('staging port')[0].entry.text, 'Staging runs on port 5433');
  h.hive.decide(ap.id, false);
  await until(() => out.includes('All set.'), 15000);
  assert.match(out, /NOT RUN/);
  assert.ok(calls >= 3);
  await h.stop();
  srv.closeAllConnections(); srv.close();
});

test('agents cannot forge senders or launder approvals', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const h = new Harness({ home, agentsDir });
  await h.start();
  h.hire({ name: 'Boss', role: 'boss', provider: 'sim', isBoss: true });
  h.hire({ name: 'Ada', role: 'dev', provider: 'sim' });
  h.hire({ name: 'Eve', role: 'dev', provider: 'sim' });
  const ap = h.hive.requestApproval('ada', 'delete', 'drop temp tables');
  h.hive.decide(ap.id, true);
  await assert.rejects(h.rpc('eve', 'task.new', { title: 'drop prod db', to: 'ada', approval: ap.id }), /not an approval granted to you/);
  // Unauthenticated HTTP is rejected.
  const res = await fetch(`${h.server.url}/rpc`, { method: 'POST', headers: { authorization: 'Bearer nope' }, body: '{"method":"roster"}' });
  assert.equal(res.status, 401);
  // Sender is whoever the token belongs to, regardless of payload.
  const m = (await h.rpc('eve', 'send', { to: 'boss', subject: 'hi', from: 'ada' })) as { from: string };
  assert.equal(m.from, 'eve');
  await h.stop();
});

test('idle CLI agents get nudged in their terminal when mail arrives', async () => {
  const home = mkdtempSync(join(tmpdir(), 'hf-'));
  const h = new Harness({ home, agentsDir, pty: { idleMs: 300 } });
  await h.start();
  const a = h.hire({ name: 'Cli', role: 'dev', provider: 'custom', command: 'bash', args: ['--noprofile', '--norc'] });
  let out = '';
  h.bus.on('pty', (b) => b.forEach((x) => (out += x.data)));
  await h.startAgent(a.id);
  await new Promise((r) => setTimeout(r, 600)); // let it go idle
  h.hive.send({ from: 'human', to: a.id, subject: 'please look at PR 7' });
  await until(() => out.includes('You have 1 new message'), 8000);
  await h.stop();
});
