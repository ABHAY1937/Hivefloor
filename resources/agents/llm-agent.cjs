#!/usr/bin/env node
// Built-in coding agent for "bring your own key" and local models.
// Speaks the OpenAI chat-completions tool-calling API (OpenAI, Ollama, LM Studio,
// vLLM, OpenRouter, Groq, …) or the Anthropic Messages API. Zero dependencies.
//
// Env: HIVE_LLM_BASE_URL, HIVE_LLM_MODEL, HIVE_LLM_API=openai|anthropic,
//      HIVE_LLM_API_KEY (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

const API = process.env.HIVE_LLM_API || 'openai';
const BASE = (process.env.HIVE_LLM_BASE_URL || (API === 'anthropic' ? 'https://api.anthropic.com' : 'http://localhost:11434/v1')).replace(/\/$/, '');
const MODEL = process.env.HIVE_LLM_MODEL || 'qwen2.5-coder:7b';
const KEY = process.env.HIVE_LLM_API_KEY || (API === 'anthropic' ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY) || '';
const MAX_STEPS = Number(process.env.HIVE_LLM_MAX_STEPS || 24);
const CWD = process.cwd();
const C = { dim: '\x1b[2m', b: '\x1b[1m', r: '\x1b[0m', g: '\x1b[32m', y: '\x1b[33m', c: '\x1b[36m', m: '\x1b[35m', red: '\x1b[31m', gr: '\x1b[90m' };
const say = (s = '') => process.stdout.write(String(s).replace(/\r?\n/g, '\r\n') + '\r\n');

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

// ─── tools ──────────────────────────────────────────────────────────────────

// Contain file tools to the working directory. A plain startsWith() check lets
// "../app-secrets" through when CWD is ".../app", and symlinks can point anywhere,
// so compare real paths with path.relative().
const ROOT = fs.realpathSync(CWD);
const inside = (full) => {
  const rel = path.relative(ROOT, full);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
};
const safePath = (p) => {
  const full = path.resolve(ROOT, p || '.');
  if (!inside(full)) throw new Error('path escapes the working directory');
  // Resolve symlinks on the deepest existing ancestor (the target may not exist yet).
  let probe = full;
  while (!fs.existsSync(probe) && path.dirname(probe) !== probe) probe = path.dirname(probe);
  if (!inside(fs.realpathSync(probe))) throw new Error('path escapes the working directory (symlink)');
  return full;
};

function runShell(cmd, timeoutMs = 120000) {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const p = spawn(isWin ? 'cmd.exe' : 'bash', isWin ? ['/d', '/s', '/c', cmd] : ['-lc', cmd], { cwd: CWD, env: process.env });
    let out = '';
    const onData = (d) => {
      const s = d.toString();
      out += s;
      process.stdout.write(`${C.gr}${s.replace(/\r?\n/g, '\r\n')}${C.r}`);
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    const t = setTimeout(() => p.kill(), timeoutMs);
    p.on('close', (code) => {
      clearTimeout(t);
      resolve(`exit ${code}\n${out.slice(-8000)}`);
    });
  });
}

const TOOLS = [
  { name: 'read_file', description: 'Read a text file relative to the working directory.', params: { path: 'string' }, required: ['path'] },
  { name: 'write_file', description: 'Create or overwrite a text file. Lease files first with hive_lease.', params: { path: 'string', content: 'string' }, required: ['path', 'content'] },
  { name: 'list_dir', description: 'List a directory.', params: { path: 'string' }, required: [] },
  { name: 'run_shell', description: 'Run a shell command in the working directory. Risky commands are held for human approval automatically.', params: { command: 'string' }, required: ['command'] },
  { name: 'hive_send', description: 'Message another agent, "boss", or "human" (boss only).', params: { to: 'string', subject: 'string', body: 'string', reply_to: 'string' }, required: ['to', 'subject'] },
  { name: 'hive_remember', description: 'Store a durable fact in long-term memory.', params: { text: 'string', shared: 'boolean' }, required: ['text'] },
  { name: 'hive_recall', description: 'Search memories.', params: { query: 'string' }, required: ['query'] },
  { name: 'hive_task_new', description: 'Create a task and assign it to an agent (boss).', params: { title: 'string', to: 'string', spec: 'string' }, required: ['title'] },
  { name: 'hive_task_done', description: 'Mark a task finished with a result summary.', params: { id: 'string', result: 'string' }, required: ['id', 'result'] },
  { name: 'hive_route', description: 'Suggest which agent should do a task.', params: { task: 'string' }, required: ['task'] },
  { name: 'hive_lease', description: 'Lease files/dirs before editing so others do not collide.', params: { paths: 'array' }, required: ['paths'] },
  { name: 'hive_release', description: 'Release your leases.', params: {}, required: [] },
  { name: 'hive_ask', description: 'Ask the human to approve spend/delete/big-change/external actions. Waits for the answer.', params: { kind: 'string', summary: 'string', detail: 'string' }, required: ['kind', 'summary'] },
  { name: 'hive_status', description: 'Set your visible status: working|idle|blocked plus a short note.', params: { status: 'string', note: 'string' }, required: ['status'] }
];

async function execTool(name, a) {
  switch (name) {
    case 'read_file':
      return fs.readFileSync(safePath(a.path), 'utf8').slice(0, 20000);
    case 'write_file':
      fs.mkdirSync(path.dirname(safePath(a.path)), { recursive: true });
      fs.writeFileSync(safePath(a.path), a.content ?? '');
      return `wrote ${a.path} (${(a.content ?? '').length} bytes)`;
    case 'list_dir':
      return fs.readdirSync(safePath(a.path || '.'), { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + '/' : d.name)).join('\n');
    case 'run_shell': {
      const v = await rpc('check', { text: a.command });
      if (v.needsApproval) {
        say(`${C.y}⚠ held for approval (${v.kind}: ${v.reason})${C.r}`);
        const ap = await rpc('ask', { kind: v.kind, summary: `Run: ${a.command}`.slice(0, 280), detail: v.reason, waitMs: 600000 });
        if (ap.status !== 'approved') return `NOT RUN — human ${ap.status} this command.`;
      }
      return runShell(a.command);
    }
    case 'hive_send':
      return rpc('send', { to: a.to, subject: a.subject, body: a.body, replyTo: a.reply_to });
    case 'hive_remember':
      return rpc('remember', { text: a.text, shared: !!a.shared });
    case 'hive_recall':
      return rpc('recall', { query: a.query });
    case 'hive_task_new':
      return rpc('task.new', a);
    case 'hive_task_done':
      return rpc('task.done', a);
    case 'hive_route':
      return rpc('route', a);
    case 'hive_lease':
      return rpc('lease', { paths: a.paths || [] });
    case 'hive_release':
      return rpc('release', {});
    case 'hive_ask':
      return rpc('ask', { ...a, waitMs: 600000 });
    case 'hive_status':
      return rpc('status', a);
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

const schema = (t) => ({
  type: 'object',
  properties: Object.fromEntries(Object.entries(t.params).map(([k, ty]) => [k, ty === 'array' ? { type: 'array', items: { type: 'string' } } : { type: ty }])),
  required: t.required
});

// ─── model adapters ─────────────────────────────────────────────────────────

async function callOpenAI(system, history) {
  const res = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(KEY ? { authorization: `Bearer ${KEY}` } : {}) },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: system }, ...history],
      tools: TOOLS.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: schema(t) } })),
      temperature: 0.2
    })
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const msg = (await res.json()).choices[0].message;
  history.push({ role: 'assistant', content: msg.content || '', ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}) });
  return {
    text: msg.content || '',
    calls: (msg.tool_calls || []).map((c) => ({ id: c.id, name: c.function.name, args: safeJson(c.function.arguments) })),
    addResults: (results) => results.forEach((r) => history.push({ role: 'tool', tool_call_id: r.id, content: r.content }))
  };
}

async function callAnthropic(system, history) {
  const res = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 4096,
      system,
      messages: history,
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, input_schema: schema(t) }))
    })
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const body = await res.json();
  history.push({ role: 'assistant', content: body.content });
  return {
    text: body.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n'),
    calls: body.content.filter((b) => b.type === 'tool_use').map((b) => ({ id: b.id, name: b.name, args: b.input })),
    addResults: (results) => history.push({ role: 'user', content: results.map((r) => ({ type: 'tool_result', tool_use_id: r.id, content: r.content })) })
  };
}

function safeJson(s) {
  try {
    return typeof s === 'string' ? JSON.parse(s || '{}') : s || {};
  } catch {
    return {};
  }
}

// ─── loop ───────────────────────────────────────────────────────────────────

let system = '';
const history = [];
let busy = false;
const queue = [];

async function runTurn(userText) {
  history.push({ role: 'user', content: userText });
  while (history.length > 40) history.splice(0, 2); // keep context bounded
  // Never start history with a dangling tool result.
  while (history.length && history[0].role !== 'user') history.shift();
  await rpc('status', { status: 'working', note: userText.split('\n')[0].slice(0, 80) }).catch(() => {});
  for (let step = 0; step < MAX_STEPS; step++) {
    say(`${C.dim}✻ thinking (${MODEL})…${C.r}`);
    let turn;
    try {
      turn = API === 'anthropic' ? await callAnthropic(system, history) : await callOpenAI(system, history);
    } catch (e) {
      say(`${C.red}model error: ${e.message.slice(0, 400)}${C.r}`);
      say(`${C.gr}Check Settings → Models (base URL ${BASE}, model ${MODEL}).${C.r}`);
      return;
    }
    if (turn.text) say(turn.text);
    if (!turn.calls.length) break;
    const results = [];
    for (const c of turn.calls) {
      say(`${C.g}●${C.r} ${C.b}${c.name}${C.r}(${JSON.stringify(c.args).slice(0, 120)})`);
      let content;
      try {
        const r = await execTool(c.name, c.args);
        content = typeof r === 'string' ? r : JSON.stringify(r);
      } catch (e) {
        content = `ERROR: ${e.message}`;
      }
      say(`  ${C.gr}⎿  ${content.split('\n')[0].slice(0, 140)}${C.r}`);
      results.push({ id: c.id, content: content.slice(0, 12000) });
    }
    turn.addResults(results);
  }
  await rpc('status', { status: 'idle', note: 'waiting for work' }).catch(() => {});
}

async function pump() {
  if (busy) return;
  busy = true;
  while (queue.length) await runTurn(queue.shift());
  busy = false;
}

async function main() {
  const me = await rpc('whoami');
  const idPath = path.join(process.env.HIVE_AGENT_DIR || '.', 'identity.md');
  system = (fs.existsSync(idPath) ? fs.readFileSync(idPath, 'utf8') : `You are ${me.name}.`) +
    `\n\nYou act through tools. The hive CLI commands map to hive_* tools. Working directory: ${CWD}. Be concise.`;
  say(`${C.c}${C.b}${me.name}${C.r} · ${me.role} ${C.gr}· ${API} ${MODEL} @ ${BASE}${C.r}`);
  say(`${C.gr}Type here to talk to me directly, or send me hive messages.${C.r}`);
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', (line) => {
    if (!line.trim()) return;
    queue.push(`The human typed in your terminal: ${line}`);
    void pump();
  });
  for (;;) {
    let msgs = [];
    try {
      msgs = await rpc('inbox', { waitMs: 30000 });
    } catch (e) {
      say(`${C.red}hive unreachable: ${e.message}${C.r}`);
      await new Promise((r) => setTimeout(r, 2000));
      continue;
    }
    if (msgs.length) {
      queue.push(`New hive messages:\n${msgs.map((m) => `[${m.id}] ${m.act} from ${m.from}: ${m.subject}\n${m.body || ''}`).join('\n\n')}`);
      void pump();
    }
  }
}

main().catch((e) => {
  say(`fatal: ${e.message}`);
  process.exit(1);
});
