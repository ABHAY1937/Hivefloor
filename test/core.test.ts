import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Hive, HOP_CAP } from '../src/core/hive';
import { MemoryIndex } from '../src/core/memory';
import { ApprovalPolicy } from '../src/core/policy';
import type { AgentSpec } from '../src/core/types';

const tmp = () => mkdtempSync(join(tmpdir(), 'hivefloor-test-'));
const spec = (id: string, isBoss = false): AgentSpec => ({
  id,
  name: id[0].toUpperCase() + id.slice(1),
  role: isBoss ? 'boss' : 'worker',
  skills: [],
  provider: 'sim',
  cwd: '/tmp',
  isolation: 'shared',
  isBoss,
  avatar: { shirt: '#000', hair: '#000', skin: '#fff' },
  createdAt: Date.now()
});

test('memory: BM25 ranks relevant entries and respects scope', () => {
  const idx = new MemoryIndex();
  const base = { tags: [], createdAt: Date.now() };
  idx.add({ ...base, id: '1', agent: 'ada', scope: 'private', text: 'The API uses bearer tokens for authentication' });
  idx.add({ ...base, id: '2', agent: 'ada', scope: 'private', text: 'Lunch is at noon' });
  idx.add({ ...base, id: '3', agent: 'lin', scope: 'shared', text: 'Authentication errors return 401 JSON' });
  idx.add({ ...base, id: '4', agent: 'lin', scope: 'private', text: 'authentication secret notes' });
  const hits = idx.recall('authentication tokens', { agent: 'ada' });
  assert.equal(hits[0].entry.id, '1');
  assert.ok(hits.some((h) => h.entry.id === '3'), 'shared memory visible');
  assert.ok(!hits.some((h) => h.entry.id === '4'), 'other agent private memory hidden');
  idx.remove('1');
  assert.equal(idx.recall('bearer', { agent: 'ada' }).length, 0);
});

test('policy: flags spend, delete, big changes; lets routine through', () => {
  const p = new ApprovalPolicy();
  assert.equal(p.classify('rm -rf build/').kind, 'delete');
  assert.equal(p.classify('git push --force origin main').kind, 'delete');
  assert.equal(p.classify('DROP TABLE users;').kind, 'delete');
  assert.equal(p.classify('buy a domain for $12').kind, 'spend');
  assert.equal(p.classify('provision 4 GPU instances').kind, 'spend');
  assert.equal(p.classify('npm publish').kind, 'big-change');
  assert.equal(p.classify('deploy to production').kind, 'big-change');
  assert.equal(p.classify('edit', { filesTouched: 40 }).kind, 'big-change');
  assert.equal(p.classify('add a login button to the header').needsApproval, false);
  assert.equal(p.classify('write unit tests for the parser').needsApproval, false);
  p.update({ spendThresholdUsd: 50 });
  assert.equal(p.classify('buy a domain for $12').needsApproval, false);
  assert.equal(p.classify('buy a server for $120').needsApproval, true);
});

test('hive: routing, aliases, inbox, broadcast', async () => {
  const h = new Hive(tmp());
  await h.open();
  h.addAgent(spec('morgan', true));
  h.addAgent(spec('ada'));
  h.addAgent(spec('lin'));
  const m = h.send({ from: 'ada', to: 'boss', subject: 'question' });
  assert.equal(m.to, 'morgan');
  assert.equal(h.unreadCount('morgan'), 1);
  // Agents writing to "human" reach the boss (the human's proxy).
  assert.equal(h.send({ from: 'lin', to: 'human', subject: 'hi' }).to, 'morgan');
  // Boss can reach the human directly.
  assert.equal(h.send({ from: 'morgan', to: 'human', subject: 'report' }).to, 'human');
  h.send({ from: 'morgan', to: 'all', subject: 'standup' });
  assert.equal(h.unreadCount('ada'), 1);
  assert.equal(h.unreadCount('lin'), 1);
  assert.equal(h.inbox('morgan', { markRead: true }).length, 2);
  assert.equal(h.unreadCount('morgan'), 0);
  assert.throws(() => h.send({ from: 'ada', to: 'nobody', subject: 'x' }));
  await h.close();
});

test('hive: hop cap escalates ping-pong loops to the boss', async () => {
  const h = new Hive(tmp());
  await h.open();
  h.addAgent(spec('morgan', true));
  h.addAgent(spec('ada'));
  h.addAgent(spec('lin'));
  let last = h.send({ from: 'ada', to: 'lin', subject: 'ping' });
  for (let i = 0; i < HOP_CAP + 2; i++) {
    const from = last.to;
    const to = from === 'ada' ? 'lin' : 'ada';
    last = h.send({ from, to, subject: 're', replyTo: last.id });
    if (last.to === 'morgan') break;
  }
  assert.equal(last.to, 'morgan');
  assert.match(last.subject, /loop-cap/);
  await h.close();
});

test('hive: long-poll wakes instantly on delivery', async () => {
  const h = new Hive(tmp());
  await h.open();
  h.addAgent(spec('ada'));
  h.addAgent(spec('lin'));
  const t0 = performance.now();
  const p = h.waitForMail('lin', 5000);
  setTimeout(() => h.send({ from: 'ada', to: 'lin', subject: 'wake' }), 20);
  assert.equal(await p, true);
  assert.ok(performance.now() - t0 < 500, 'woke well before the timeout');
  await h.close();
});

test('hive: leases prevent overlapping edits', async () => {
  const h = new Hive(tmp());
  await h.open();
  assert.equal(h.acquireLeases('ada', ['src/api']).ok, true);
  const r = h.acquireLeases('lin', ['src/api/users.ts']);
  assert.equal(r.ok, false);
  assert.equal(r.conflicts[0].agent, 'ada');
  assert.equal(h.acquireLeases('lin', ['src/ui']).ok, true);
  assert.equal(h.acquireLeases('ada', ['src/api/users.ts']).ok, true, 'own leases never conflict');
  h.releaseLeases('ada');
  assert.equal(h.acquireLeases('lin', ['src/api/users.ts']).ok, true);
  await h.close();
});

test('hive: approvals notify the requesting agent', async () => {
  const h = new Hive(tmp());
  await h.open();
  h.addAgent(spec('ada'));
  const a = h.requestApproval('ada', 'delete', 'drop the staging db');
  assert.equal(h.requestApproval('ada', 'delete', 'drop the staging db').id, a.id, 'deduplicated');
  assert.equal(h.listApprovals('pending').length, 1);
  h.decide(a.id, false, 'not today');
  const inbox = h.inbox('ada');
  assert.equal(inbox[0].act, 'refuse');
  assert.match(inbox[0].subject, /DENIED/);
  await h.close();
});

test('hive: state survives restart (snapshot + WAL replay) and memory.md is written', async () => {
  const dir = tmp();
  const h = new Hive(dir);
  await h.open();
  h.addAgent(spec('ada'));
  h.remember('ada', 'The staging DB lives on port 5433', { tags: ['infra'] });
  h.createTask({ title: 'Ship it', createdBy: 'human', assignee: 'ada' });
  h.send({ from: 'human', to: 'ada', subject: 'hello' });
  await h.close();

  // Simulate a crash after more writes: new events only in the WAL.
  const h2 = new Hive(dir);
  await h2.open();
  h2.remember('ada', 'Use pnpm, not npm');
  // Don't close cleanly: wait for the WAL stream to flush, then reopen.
  await new Promise((r) => setTimeout(r, 50));
  const h3 = new Hive(dir);
  await h3.open();
  assert.equal(h3.listAgents().length, 1);
  assert.equal(h3.listTasks()[0].title, 'Ship it');
  assert.equal(h3.unreadCount('ada'), 1);
  assert.equal(h3.memory.recall('pnpm', { agent: 'ada' })[0]?.entry.text, 'Use pnpm, not npm');
  assert.equal(h3.memory.recall('staging port', { agent: 'ada' })[0]?.entry.text, 'The staging DB lives on port 5433');
  await h3.close();
  const md = join(dir, 'agents', 'ada', 'memory.md');
  assert.ok(existsSync(md));
  assert.match(readFileSync(md, 'utf8'), /port 5433/);
});
