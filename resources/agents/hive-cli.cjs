#!/usr/bin/env node
// The `hive` CLI — the agent-facing API. Zero dependencies; talks to the harness
// control server over loopback HTTP using the agent's own token.
'use strict';

const URL_ = process.env.HIVE_URL;
const TOKEN = process.env.HIVE_TOKEN;

async function rpc(method, params = {}) {
  if (!URL_ || !TOKEN) throw new Error('not running inside a Hivefloor agent (HIVE_URL/HIVE_TOKEN missing)');
  const res = await fetch(`${URL_}/rpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ method, params })
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) throw new Error(body.error || `HTTP ${res.status}`);
  return body.result;
}

function parse(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2);
      if (v !== undefined) flags[k] = v;
      else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
      else flags[k] = true;
    } else pos.push(a);
  }
  return { pos, flags };
}

const ago = (t) => {
  const s = Math.round((Date.now() - t) / 1000);
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

function printMessages(list) {
  if (!list.length) return console.log('(no new messages)');
  for (const m of list) {
    console.log(`\n[${m.id}] ${m.act.toUpperCase()} from ${m.from} → ${m.to} · ${ago(m.createdAt)}`);
    console.log(`  ${m.subject}`);
    if (m.body) console.log(m.body.split('\n').map((l) => `    ${l}`).join('\n'));
  }
  console.log(`\nReply with: hive send <agent> "<subject>" --body "..." --reply <msg-id>`);
}

const HELP = `hive — talk to your office

  hive whoami | roster
  hive inbox [--all] [--wait <sec>] [--peek]
  hive send <agent|boss|human|all> "<subject>" [--body "..."] [--act request|inform|query|done] [--reply <id>]
  hive remember "<fact>" [--shared] [--tags a,b]
  hive recall "<query>" [--limit n]
  hive task list [--mine] | new "<title>" [--to agent] [--spec "..."] [--approval <id>] | claim <id> | done <id> [--result "..."] [--failed]
  hive status <working|idle|blocked> "<note>"
  hive board [--append "<line>"] [--set "<text>"]
  hive lease <path...> [--ttl <min>] | release [path...] | leases
  hive check "<command or plan>" [--task <id>]  # would this need human approval?
  hive ask <spend|delete|big-change|external|other> "<summary>" [--detail "..."] [--wait <sec>]
  hive route "<task>"                   # who should do this?
  hive hook stop                        # Claude Code Stop hook (reads JSON on stdin)
Add --json to any command for raw output.`;

async function readStdin() {
  if (process.stdin.isTTY) return '';
  let s = '';
  for await (const c of process.stdin) s += c;
  return s;
}

async function main() {
  const { pos, flags } = parse(process.argv.slice(2));
  const cmd = pos.shift();
  const json = !!flags.json;
  const out = (r, pretty) => (json ? console.log(JSON.stringify(r, null, 2)) : pretty(r));

  switch (cmd) {
    case undefined:
    case 'help':
    case '--help':
      return console.log(HELP);
    case 'whoami':
      return out(await rpc('whoami'), (r) => console.log(`${r.name} (${r.id}) — ${r.role}${r.isBoss ? ' [BOSS]' : ''}`));
    case 'roster':
      return out(await rpc('roster'), (r) =>
        r.forEach((a) => console.log(`${a.isBoss ? '★' : '•'} ${a.id.padEnd(12)} ${a.name.padEnd(10)} ${a.status.padEnd(8)} ${a.role}${a.note ? ` — ${a.note}` : ''}`))
      );
    case 'inbox':
      return out(
        await rpc('inbox', { all: !!flags.all, peek: !!flags.peek, waitMs: flags.wait ? Number(flags.wait) * 1000 : 0 }),
        printMessages
      );
    case 'read':
      return out(await rpc('read', { id: pos[0] }), (m) => printMessages([m]));
    case 'send': {
      const [to, ...rest] = pos;
      const subject = rest.join(' ');
      if (!to || !subject) throw new Error('usage: hive send <to> "<subject>" [--body ...]');
      return out(
        await rpc('send', { to, subject, body: flags.body === true ? '' : flags.body, act: flags.act, replyTo: flags.reply }),
        (m) => console.log(`sent ${m.id} → ${m.to}`)
      );
    }
    case 'remember':
      return out(await rpc('remember', { text: pos.join(' '), shared: !!flags.shared, tags: flags.tags }), (e) =>
        console.log(`remembered (${e.scope}) ${e.id}`)
      );
    case 'recall':
      return out(await rpc('recall', { query: pos.join(' '), limit: flags.limit }), (r) => {
        if (!r.length) return console.log('(nothing relevant in memory)');
        r.forEach((e) => console.log(`- ${e.text}${e.scope === 'shared' ? ` [shared by ${e.agent}]` : ''}`));
      });
    case 'task': {
      const sub = pos.shift();
      if (sub === 'new')
        return out(await rpc('task.new', { title: pos.join(' '), to: flags.to, spec: flags.spec, approval: flags.approval }), (t) =>
          console.log(`task ${t.id} created${t.assignee ? ` → ${t.assignee}` : ''}`)
        );
      if (sub === 'claim') return out(await rpc('task.claim', { id: pos[0] }), (t) => console.log(`claimed ${t.id}`));
      if (sub === 'done')
        return out(await rpc('task.done', { id: pos[0], result: flags.result, failed: !!flags.failed }), (t) =>
          console.log(`task ${t.id} ${t.status}`)
        );
      return out(await rpc('task.list', { mine: !!flags.mine }), (r) => {
        if (!r.length) return console.log('(no tasks)');
        r.forEach((t) => console.log(`${t.id}  ${t.status.padEnd(7)} ${(t.assignee || '-').padEnd(10)} ${t.title}`));
      });
    }
    case 'status':
      return out(await rpc('status', { status: pos[0], note: pos.slice(1).join(' ') }), (s) => console.log(`status: ${s.status} — ${s.note}`));
    case 'board':
      if (flags.append) return out(await rpc('board.append', { text: flags.append }), () => console.log('board updated'));
      if (flags.set) return out(await rpc('board.set', { text: flags.set }), () => console.log('board replaced'));
      return out(await rpc('board.get'), (b) => console.log(b || '(board is empty)'));
    case 'lease':
      return out(await rpc('lease', { paths: pos, ttlMs: flags.ttl ? Number(flags.ttl) * 60_000 : undefined }), (r) => {
        if (r.ok) console.log(`leased: ${pos.join(', ')}`);
        else {
          console.log(`REFUSED — already leased:`);
          r.conflicts.forEach((c) => console.log(`  ${c.path} by ${c.agent}`));
          process.exitCode = 2;
        }
      });
    case 'release':
      return out(await rpc('release', { paths: pos.length ? pos : undefined }), (r) => console.log(`released ${r.released} lease(s)`));
    case 'leases':
      return out(await rpc('leases'), (r) => (r.length ? r.forEach((l) => console.log(`${l.path}  ${l.agent}`)) : console.log('(no leases)')));
    case 'check':
      return out(await rpc('check', { text: pos.join(' '), files: flags.files, task: flags.task }), (v) =>
        console.log(v.needsApproval ? `NEEDS APPROVAL (${v.kind}): ${v.reason} — use: hive ask ${v.kind} "<summary>"` : 'ok — routine, no approval needed')
      );
    case 'ask': {
      const [kind, ...rest] = pos;
      const r = await rpc('ask', { kind, summary: rest.join(' '), detail: flags.detail, waitMs: flags.wait ? Number(flags.wait) * 1000 : 0 });
      return out(r, (a) =>
        console.log(a.status === 'pending' ? `approval ${a.id} requested — you will get an inbox message when the human decides` : `approval ${a.id}: ${a.status.toUpperCase()}${a.reason ? ` (${a.reason})` : ''}`)
      );
    }
    case 'route':
      return out(await rpc('route', { task: pos.join(' ') }), (r) =>
        r.forEach((x, i) => console.log(`${i === 0 ? '→' : ' '} ${x.id.padEnd(12)} score ${x.score}  (${x.status})`))
      );
    case 'hook': {
      if (pos[0] !== 'stop') throw new Error('usage: hive hook stop');
      let payload = {};
      try {
        payload = JSON.parse((await readStdin()) || '{}');
      } catch {}
      const r = await rpc('hook.stop', { stop_hook_active: !!payload.stop_hook_active });
      if (r && r.decision) console.log(JSON.stringify(r));
      return;
    }
    default:
      throw new Error(`unknown command "${cmd}". Run: hive help`);
  }
}

main().catch((e) => {
  console.error(`hive: ${e.message}`);
  process.exit(1);
});
