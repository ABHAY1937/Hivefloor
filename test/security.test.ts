// Regression tests for the agent-facing authorization rules. Agents are treated as
// semi-trusted: they may be prompt-injected, so every RPC is checked against the
// authenticated caller, not against what the payload claims.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Harness } from '../src/core/harness';
import { resolveCommand } from '../src/core/pty';

const agentsDir = resolve(__dirname, '../resources/agents');

async function office() {
  const home = mkdtempSync(join(tmpdir(), 'hf-sec-'));
  const h = new Harness({ home, agentsDir });
  await h.start();
  h.hire({ name: 'Boss', role: 'boss', provider: 'sim', isBoss: true });
  h.hire({ name: 'Ada', role: 'dev', provider: 'sim' });
  h.hire({ name: 'Eve', role: 'dev', provider: 'sim' });
  return h;
}

test('only the assignee, creator or boss can close a task', async () => {
  const h = await office();
  const t = (await h.rpc('boss', 'task.new', { title: 'build login', to: 'ada' })) as { id: string };
  await assert.rejects(h.rpc('eve', 'task.done', { id: t.id, result: 'lol' }), /not yours to close/);
  await h.rpc('ada', 'task.done', { id: t.id, result: 'done' });
  await h.stop();
});

test('a task approval only covers the kind of risk the human approved', async () => {
  const h = await office();
  const ap = h.hive.requestApproval('boss', 'spend', 'buy a $12 domain');
  h.hive.decide(ap.id, true);
  const t = (await h.rpc('boss', 'task.new', { title: 'register domain', to: 'ada', approval: ap.id })) as { id: string };
  const spend = (await h.rpc('ada', 'check', { text: 'pay for the domain, $12', task: t.id })) as { needsApproval: boolean };
  assert.equal(spend.needsApproval, false, 'approved kind passes');
  const del = (await h.rpc('ada', 'check', { text: 'rm -rf /srv/data', task: t.id })) as { needsApproval: boolean };
  assert.equal(del.needsApproval, true, 'a spend approval must not green-light a delete');
  // Another agent can't ride on Ada's task approval either.
  const eve = (await h.rpc('eve', 'check', { text: 'pay for the domain, $12', task: t.id })) as { needsApproval: boolean };
  assert.equal(eve.needsApproval, true);
  await h.stop();
});

test('agents cannot fake the waiting status, replace the board, or read others\' approvals', async () => {
  const h = await office();
  await assert.rejects(h.rpc('eve', 'status', { status: 'waiting', note: 'x' }), /pending approval/);
  await assert.rejects(h.rpc('eve', 'status', { status: 'offline' }), /status must be one of/);
  await assert.rejects(h.rpc('eve', 'board.set', { text: 'wiped' }), /only the boss/);
  await h.rpc('eve', 'board.append', { text: 'fine' });
  const ap = h.hive.requestApproval('ada', 'delete', 'drop temp tables');
  await assert.rejects(h.rpc('eve', 'approval', { id: ap.id }), /no such approval/);
  assert.equal(((await h.rpc('ada', 'approval', { id: ap.id })) as { id: string }).id, ap.id);
  await assert.rejects(h.rpc('eve', 'ask', { kind: 'nuke', summary: 'x' }), /kind must be one of/);
  await h.stop();
});

test('control server rejects foreign Host headers (DNS rebinding) and malformed params', async () => {
  const h = await office();
  const token = (h as unknown as { tokens: Map<string, string> }).tokens;
  // Register a token for Ada the way startAgent would.
  h.server.register('tok-ada', 'ada');
  token.set('ada', 'tok-ada');
  const call = (host: string, body: string) =>
    new Promise<number>((res, rej) => {
      const req = request(
        { host: '127.0.0.1', port: h.server.port, path: '/rpc', method: 'POST', headers: { host, authorization: 'Bearer tok-ada', 'content-type': 'application/json' } },
        (r) => {
          r.resume();
          res(r.statusCode ?? 0);
        }
      );
      req.on('error', rej);
      req.end(body);
    });
  assert.equal(await call('evil.example:80', '{"method":"roster"}'), 403);
  assert.equal(await call(`127.0.0.1:${h.server.port}`, '{"method":"roster"}'), 200);
  assert.equal(await call(`127.0.0.1:${h.server.port}`, '{"method":"roster","params":[1]}'), 400);
  await h.stop();
});

test('llm-agent file tools stay inside the working directory', async () => {
  // Load the agent's safePath without running its main loop.
  const root = mkdtempSync(join(tmpdir(), 'hf-cwd-'));
  const app = join(root, 'app');
  mkdirSync(app);
  mkdirSync(join(root, 'app-secrets'));
  writeFileSync(join(root, 'app-secrets', 'key'), 'x');
  let linked = true;
  try {
    symlinkSync(join(root, 'app-secrets'), join(app, 'link'), 'junction');
  } catch {
    linked = false; // no symlink permission on this machine
  }
  const src = require('node:fs').readFileSync(join(agentsDir, 'llm-agent.cjs'), 'utf8') as string;
  const body = src.slice(src.indexOf('const ROOT'), src.indexOf('function runShell'));
  const safePath = new Function('fs', 'path', 'CWD', `${body}; return safePath;`)(require('node:fs'), require('node:path'), app) as (p: string) => string;
  assert.ok(safePath('src/x.ts').startsWith(app));
  assert.throws(() => safePath('../app-secrets/key'), /escapes/, 'sibling dir with a shared prefix');
  assert.throws(() => safePath('/etc/passwd'), /escapes/);
  if (linked) assert.throws(() => safePath('link/key'), /symlink/);
});

test('Windows command resolution finds .cmd/.exe shims on PATH', { skip: process.platform !== 'win32' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'hf-bin-'));
  writeFileSync(join(dir, 'fakeagent.cmd'), '@echo off');
  assert.equal(resolveCommand('fakeagent', { PATH: dir, PATHEXT: '.EXE;.CMD' }).toLowerCase(), join(dir, 'fakeagent.cmd').toLowerCase());
  assert.equal(resolveCommand('C:\\x\\y.exe', { PATH: dir }), 'C:\\x\\y.exe');
});
