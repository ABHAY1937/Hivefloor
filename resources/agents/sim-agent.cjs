#!/usr/bin/env node
// Demo worker: a scripted "coding agent" that uses the real hive API end to end —
// long-poll inbox, routing, tasks, leases, memory, peer messages and approvals —
// and writes real files into its workdir. No API keys needed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const SPEED = Math.max(0.1, Number(process.env.HIVE_SIM_SPEED || 1));
const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', red: '\x1b[31m', gr: '\x1b[90m' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const jitter = (a, b) => a + Math.random() * (b - a);

async function rpc(method, params = {}) {
  const res = await fetch(`${process.env.HIVE_URL}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.HIVE_TOKEN}` },
    body: JSON.stringify({ method, params })
  });
  const body = await res.json();
  if (!body.ok) throw new Error(body.error);
  return body.result;
}

const say = (s = '') => process.stdout.write(s + '\r\n');
const tool = (name, arg) => say(`${C.g}●${C.r} ${C.b}${name}${C.r}(${arg})`);
const sub = (s) => say(`  ${C.gr}⎿  ${s}${C.r}`);
async function shell(cmd, lines = [], ms = 600) {
  say(`${C.m}●${C.r} ${C.b}Bash${C.r}(${cmd})`);
  await sleep(ms);
  for (const l of lines) sub(l);
}
async function think(text) {
  say(`${C.dim}✻ ${text}…${C.r}`);
  await sleep(jitter(500, 1100));
}

let me;
const workdir = process.cwd();

function banner() {
  const W = 50;
  const line = (plain, styled) => say(`${C.c}│${C.r} ${styled}${' '.repeat(Math.max(0, W - 1 - plain.length))}${C.c}│${C.r}`);
  say(`${C.c}╭${'─'.repeat(W)}╮${C.r}`);
  line(`${me.name} · ${me.role}${me.isBoss ? ' ★' : ''}`, `${C.b}${me.name}${C.r} · ${me.role}${me.isBoss ? ` ${C.y}★${C.r}` : ''}`);
  const sub2 = `hivefloor demo worker · cwd ${path.basename(workdir)}`;
  line(sub2, `${C.gr}${sub2}${C.r}`);
  say(`${C.c}╰${'─'.repeat(W)}╯${C.r}`);
}

// ─── boss behaviour ─────────────────────────────────────────────────────────

const pendingPlans = new Map(); // approvalSummary -> plan
const convTasks = new Map(); // taskId -> { conv, title }
const openByConv = new Map(); // conv -> Set(taskId)

function splitRequest(text) {
  return text
    .split(/\n+|;|\.\s+|\band then\b|\bthen\b|,\s*and\b|\band\b(?=\s+(?:add|build|write|create|fix|set|make|deploy|test|update|design|delete|buy|remove|refactor))/i)
    .map((s) => s.replace(/^\s*(also|please|and)\s+/i, '').replace(/[\s,;:.]+$/, '').replace(/\s+for it$/i, '').trim())
    .filter((s) => s.length > 3);
}

async function bossHandle(m) {
  if (m.from === 'human' && (m.act === 'agree' || m.act === 'refuse')) {
    const summary = m.subject.replace(/^(APPROVED|DENIED):\s*/, '');
    const apId = ((m.body || '').match(/Approval (a[a-z0-9]+)/) || [])[1];
    const plan = pendingPlans.get(apId);
    pendingPlans.delete(apId);
    if (m.act === 'refuse') {
      say(`${C.red}✗ Human denied:${C.r} ${summary}`);
      await rpc('send', { to: 'human', subject: `Understood — I won't do: ${summary}`, act: 'inform' });
      return;
    }
    say(`${C.g}✓ Human approved:${C.r} ${summary}`);
    if (plan) await dispatch(plan.parts, plan.conv, apId);
    return;
  }
  if (m.from === 'human') {
    say('');
    say(`${C.b}${C.y}> ${m.body || m.subject}${C.r}`);
    await think('Breaking the request into tasks');
    const parts = splitRequest(m.body || m.subject);
    const verdict = await rpc('check', { text: m.body || m.subject });
    tool('hive check', JSON.stringify((m.body || m.subject).slice(0, 40) + '…'));
    if (verdict.needsApproval) {
      sub(`${C.y}needs approval (${verdict.kind}): ${verdict.reason}${C.r}`);
      const summary = (m.body || m.subject).slice(0, 140);
      const ap = await rpc('ask', { kind: verdict.kind, summary, detail: `Planned tasks:\n${parts.map((p) => `- ${p}`).join('\n')}` });
      pendingPlans.set(ap.id, { parts, conv: m.conv });
      await rpc('status', { status: 'waiting', note: 'waiting on your approval' });
      await rpc('send', { to: 'human', subject: `Needs your OK (${verdict.kind}) before I start`, body: `I flagged this as ${verdict.kind}: ${verdict.reason}. Check the Approvals tab.`, act: 'query' });
      return;
    }
    sub('routine — no approval needed');
    await dispatch(parts, m.conv, null);
    return;
  }
  if (m.act === 'done') {
    say(`${C.g}✓${C.r} ${m.from} finished: ${m.subject.replace(/^Done:\s*/, '')}`);
    const taskId = [...convTasks.entries()].find(([, v]) => m.subject.includes(v.title))?.[0];
    await rpc('remember', { text: `${m.from} completed "${m.subject.replace(/^Done:\s*/, '')}": ${(m.body || '').slice(0, 200)}`, shared: true, tags: 'progress' });
    if (taskId) {
      const { conv, title } = convTasks.get(taskId);
      convTasks.delete(taskId);
      const open = openByConv.get(conv);
      open?.delete(taskId);
      await rpc('board.append', { text: `✓ ${title} (${m.from})` });
      if (open && open.size === 0) {
        openByConv.delete(conv);
        await think('Everything for this request is done — writing the report');
        await rpc('send', { to: 'human', act: 'done', subject: 'All done ✔', body: `Your request is complete. Latest: ${m.from} — ${m.body || m.subject}` });
        await rpc('status', { status: 'idle', note: 'all requests delivered' });
      }
    }
    return;
  }
  if (m.act === 'request' || m.act === 'query') {
    await think(`Answering ${m.from}`);
    await rpc('send', {
      to: m.from,
      replyTo: m.id,
      act: 'inform',
      subject: `Re: ${m.subject}`,
      body: 'Routine call — go with the existing conventions in the repo and keep the change small. No need to escalate.'
    });
    sub(`answered ${m.from} myself (routine, no need to bother the human)`);
  }
}

async function dispatch(parts, conv, approval) {
  const assigned = [];
  for (const part of parts) {
    const ranked = await rpc('route', { task: part });
    tool('hive route', JSON.stringify(part.slice(0, 48)));
    const pick = ranked[0];
    if (!pick) continue;
    sub(`best fit: ${pick.id} (score ${pick.score})`);
    const t = await rpc('task.new', { title: part.slice(0, 90), to: pick.id, spec: `${part}${approval ? `\n\n(Human approved this: ${approval})` : ''}`, ...(approval ? { approval } : {}) });
    convTasks.set(t.id, { conv, title: t.title });
    if (!openByConv.has(conv)) openByConv.set(conv, new Set());
    openByConv.get(conv).add(t.id);
    assigned.push(`${pick.id}: ${part}`);
    await sleep(250);
  }
  await rpc('board.append', { text: `Plan: ${assigned.join(' | ')}` });
  await rpc('status', { status: 'working', note: `coordinating ${assigned.length} task(s)` });
  await rpc('send', { to: 'human', act: 'inform', subject: `On it — ${assigned.length} task(s) routed`, body: assigned.map((a) => `• ${a}`).join('\n') });
}

// ─── worker behaviour ───────────────────────────────────────────────────────

function filesFor(title) {
  const t = title.toLowerCase();
  if (/deploy|docker|\bci\b|pipeline|infra|release|production/.test(t)) return ['Dockerfile', '.github/workflows/ci.yml', 'deploy/prod.yaml'];
  if (/test|qa|bug|regression|coverage/.test(t)) return ['tests/api.test.ts', 'tests/ui.test.ts'];
  if (/api|endpoint|auth|login|server|database|sql/.test(t)) return ['src/api/routes.ts', 'src/api/auth.ts', 'src/db/schema.sql'];
  if (/ui|page|react|button|css|design|dashboard|component/.test(t)) return ['src/ui/App.tsx', 'src/ui/Dashboard.tsx', 'src/ui/styles.css'];
  return ['src/index.ts'];
}

async function writeRealFile(rel, title) {
  const full = path.join(workdir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const stamp = new Date().toISOString();
  fs.appendFileSync(full, `${rel.endsWith('.sql') ? '--' : rel.endsWith('.yml') || rel.endsWith('.yaml') || rel === 'Dockerfile' ? '#' : '//'} ${me.name}: ${title} (${stamp})\n`);
}

async function workerHandle(m) {
  if (m.act === 'query' && m.from !== 'boss' && m.from !== 'human') {
    await think(`${m.from} is asking me something`);
    const recall = await rpc('recall', { query: m.subject, limit: 2 });
    await rpc('send', {
      to: m.from,
      replyTo: m.id,
      act: 'inform',
      subject: `Re: ${m.subject}`,
      body: recall.length ? `From my notes: ${recall[0].text}` : 'Use JSON over REST: GET /api/items → { items: Item[] }, auth via Bearer token.'
    });
    sub(`replied to ${m.from}`);
    return;
  }
  if (m.act === 'agree' || m.act === 'refuse' || m.act === 'inform' || m.act === 'done') {
    sub(`${C.gr}noted: ${m.subject}${C.r}`);
    return;
  }
  const taskId = (m.subject.match(/Task (t[a-z0-9]+)/) || [])[1];
  const title = m.subject.replace(/^Task t[a-z0-9]+:\s*/, '');
  say('');
  say(`${C.b}${C.y}> ${title}${C.r}`);
  await rpc('status', { status: 'working', note: title.slice(0, 80) });

  tool('hive recall', JSON.stringify(title.slice(0, 40)));
  const mem = await rpc('recall', { query: title, limit: 3 });
  sub(mem.length ? `${mem.length} relevant memories — e.g. "${mem[0].text.slice(0, 70)}"` : 'nothing relevant yet');

  const risky = await rpc('check', { text: title, task: taskId });
  if (risky.approval) sub(`${C.g}pre-approved by the human (${risky.approval})${C.r}`);
  if (risky.needsApproval) {
    say(`${C.y}⚠ This needs human approval (${risky.kind}: ${risky.reason}).${C.r}`);
    tool('hive ask', `${risky.kind} ${JSON.stringify(title.slice(0, 40))} --wait`);
    await rpc('status', { status: 'waiting', note: `approval: ${title.slice(0, 60)}` });
    const a = await rpc('ask', { kind: risky.kind, summary: title, detail: `Requested by ${m.from} in ${taskId || 'a message'}`, waitMs: 600000 });
    if (a.status !== 'approved') {
      say(`${C.red}✗ Not approved — skipping.${C.r}`);
      if (taskId) await rpc('task.done', { id: taskId, failed: true, result: `Skipped: human ${a.status} the ${risky.kind} step.` });
      return;
    }
    say(`${C.g}✓ Approved — proceeding.${C.r}`);
  }

  const files = filesFor(title);
  tool('hive lease', files.join(' '));
  let lease = await rpc('lease', { paths: files });
  let tries = 0;
  while (!lease.ok && tries++ < 20) {
    sub(`${C.y}waiting: ${lease.conflicts[0].path} is leased by ${lease.conflicts[0].agent}${C.r}`);
    await rpc('status', { status: 'blocked', note: `waiting on ${lease.conflicts[0].agent}'s files` });
    await sleep(1500);
    lease = await rpc('lease', { paths: files });
  }
  sub('leased');
  await rpc('status', { status: 'working', note: title.slice(0, 80) });

  for (const f of files) {
    tool('Read', f);
    await sleep(jitter(250, 600));
    sub(`${Math.floor(jitter(20, 240))} lines`);
  }
  // Collaborate: frontend asks backend about the API shape, etc.
  if (files[0].startsWith('src/ui')) {
    const roster = await rpc('roster');
    const be = roster.find((a) => /backend/i.test(a.role));
    if (be) {
      tool('hive send', `${be.id} "What shape does the items API return?"`);
      await rpc('send', { to: be.id, act: 'query', subject: 'What shape does the items API return?', body: `Building: ${title}` });
      sub('asked — continuing with a sensible default meanwhile');
    }
  }
  await think('Planning the change');
  for (const f of files) {
    tool('Edit', f);
    await sleep(jitter(400, 900));
    await writeRealFile(f, title);
    const add = Math.floor(jitter(4, 60));
    sub(`${C.g}+${add}${C.r} ${C.red}-${Math.floor(add / 3)}${C.r}`);
  }
  await rpc('status', { status: 'working', note: 'running tests' });
  const n = Math.floor(jitter(8, 40));
  await shell('npm test', [`${C.g}✓ ${n} passed${C.r} ${C.gr}(${jitter(0.8, 4).toFixed(2)}s)${C.r}`], jitter(700, 1500));
  const learning = `For "${title.slice(0, 60)}" I changed ${files.join(', ')}; tests: ${n} passing.`;
  tool('hive remember', JSON.stringify(learning.slice(0, 50) + '…'));
  await rpc('remember', { text: learning, tags: 'worklog' });
  await rpc('release', {});
  if (taskId) await rpc('task.done', { id: taskId, result: `Changed ${files.join(', ')} — ${n} tests passing.` });
  say(`${C.g}✓ Done:${C.r} ${title}`);
}

async function main() {
  me = await rpc('whoami');
  banner();
  tool('hive recall', '"project"');
  const mem = await rpc('recall', { query: 'project conventions', limit: 3 });
  sub(mem.length ? `loaded ${mem.length} memories from previous sessions` : 'fresh start — no memories yet');
  await rpc('status', { status: 'idle', note: me.isBoss ? 'ready for your requests' : 'waiting for work' });
  say(`${C.gr}waiting for messages…${C.r}`);
  for (;;) {
    let msgs = [];
    try {
      msgs = await rpc('inbox', { waitMs: 30000 });
    } catch (e) {
      say(`${C.red}hive unreachable: ${e.message}${C.r}`);
      await sleep(2000);
      continue;
    }
    for (const m of msgs) {
      try {
        await (me.isBoss ? bossHandle(m) : workerHandle(m));
      } catch (e) {
        say(`${C.red}error: ${e.message}${C.r}`);
      }
    }
    if (msgs.length) {
      const waiting = me.isBoss && pendingPlans.size > 0;
      await rpc('status', waiting ? { status: 'waiting', note: `waiting on your approval (${pendingPlans.size})` } : { status: 'idle', note: me.isBoss ? 'ready' : 'waiting for work' }).catch(() => {});
      say(`${C.gr}waiting for messages…${C.r}`);
    }
  }
}

main().catch((e) => {
  say(`fatal: ${e.message}`);
  process.exit(1);
});
