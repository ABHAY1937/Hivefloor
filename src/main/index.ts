// Electron main: a thin shell around the core Harness. All state lives in the
// harness; this file owns windows, settings/keys, and the IPC bridge.
//
// IPC design for performance:
//  - One invoke channel ('hf:call') with a whitelisted method table.
//  - Hive events + live signals are coalesced and pushed ~30x/s on 'hf:events'.
//  - PTY output is forwarded ONLY for terminals the UI is actually showing
//    ("watched"); unwatched sessions are auto-acked in main and replayed from
//    the ring buffer when opened. 20 agents cost the same IPC as 1 visible one.

import { app, BrowserWindow, ipcMain, safeStorage, dialog } from 'electron';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../core/harness';
import type { LiveSignal, SequencedEvent } from '../core/types';
import type { PolicyConfig } from '../core/policy';
import { validImage } from '../core/sandbox';
import { writeAtomicSync } from '../core/util';

interface Settings {
  llm: { baseUrl: string; model: string; api: 'openai' | 'anthropic' };
  /** Encrypted with the OS keychain (safeStorage) when available. */
  secrets: Record<string, string>;
  policy: Partial<PolicyConfig>;
  workspace: string;
  seeded: boolean;
}

const HOME = process.env.HIVEFLOOR_HOME || join(homedir(), '.hivefloor');
const SETTINGS_PATH = join(HOME, 'settings.json');
const DEFAULTS: Settings = {
  llm: { baseUrl: 'http://localhost:11434/v1', model: 'qwen2.5-coder:7b', api: 'openai' },
  secrets: {},
  policy: {},
  workspace: join(HOME, 'workspace'),
  seeded: false
};

function loadSettings(): Settings {
  try {
    return { ...DEFAULTS, ...JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) };
  } catch {
    return { ...DEFAULTS };
  }
}
function saveSettings(s: Settings): void {
  // Owner-only: this file holds (encrypted, or on keychain-less Linux, raw) API keys.
  writeAtomicSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 0o600);
}
let warnedPlaintext = false;
function encrypt(v: string): string {
  if (safeStorage.isEncryptionAvailable()) return `enc:${safeStorage.encryptString(v).toString('base64')}`;
  if (!warnedPlaintext) {
    warnedPlaintext = true;
    console.warn('[settings] OS keychain unavailable: API keys are stored unencrypted in settings.json (mode 0600)');
  }
  return `raw:${v}`;
}

// ─── renderer input validation ──────────────────────────────────────────────
// The renderer is our own UI, but treat it as untrusted: an XSS there must not
// turn into arbitrary command execution or file access in the main process.

const str = (v: unknown, name: string, max = 2000): string => {
  if (typeof v !== 'string' || v.length > max) throw new Error(`${name} must be a string (≤${max} chars)`);
  return v;
};
const strList = (v: unknown, name: string): string[] => {
  if (!Array.isArray(v) || v.length > 100) throw new Error(`${name} must be a list`);
  return v.map((x, i) => str(x, `${name}[${i}]`, 500));
};
const SECRET_NAME = /^[A-Z_][A-Z0-9_]{0,63}$/;
const AGENT_FIELDS: Record<string, (v: unknown) => unknown> = {
  name: (v) => str(v, 'name', 80),
  role: (v) => str(v, 'role', 200),
  skills: (v) => strList(v, 'skills'),
  provider: (v) => str(v, 'provider', 40),
  model: (v) => (v === undefined ? undefined : str(v, 'model', 200)),
  cwd: (v) => str(v, 'cwd', 1000),
  isolation: (v) => {
    if (v !== 'shared' && v !== 'worktree') throw new Error('isolation must be shared|worktree');
    return v;
  },
  command: (v) => (v === undefined ? undefined : str(v, 'command', 1000)),
  args: (v) => (v === undefined ? undefined : strList(v, 'args')),
  sandbox: (v) => {
    if (v !== 'none' && v !== 'docker') throw new Error('sandbox must be none|docker');
    return v;
  },
  sandboxImage: (v) => {
    if (v === undefined || v === '') return undefined;
    // Validated so an image name can't smuggle docker flags such as --privileged.
    if (typeof v !== 'string' || !validImage(v)) throw new Error('sandboxImage is not a valid image name');
    return v;
  },
  secrets: (v) => {
    const names = strList(v, 'secrets');
    for (const n of names) if (!SECRET_NAME.test(n)) throw new Error(`"${n}" is not a valid key name`);
    return names;
  }
};
function cleanAgentPatch(patch: unknown): Record<string, unknown> {
  if (!patch || typeof patch !== 'object') throw new Error('patch must be an object');
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const check = Object.hasOwn(AGENT_FIELDS, k) ? AGENT_FIELDS[k] : undefined;
    if (!check) throw new Error(`field "${k}" cannot be changed`);
    out[k] = check(v);
  }
  return out;
}
function cleanLlm(v: unknown): Settings['llm'] {
  const o = (v ?? {}) as Record<string, unknown>;
  const baseUrl = str(o.baseUrl, 'baseUrl', 500);
  const u = new URL(baseUrl);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new Error('baseUrl must be http(s)');
  if (o.api !== 'openai' && o.api !== 'anthropic') throw new Error('api must be openai|anthropic');
  return { baseUrl, model: str(o.model, 'model', 200), api: o.api };
}
function cleanPolicy(v: unknown): Partial<PolicyConfig> {
  const o = (v ?? {}) as Record<string, unknown>;
  const out: Partial<PolicyConfig> = {};
  const num = (x: unknown, name: string) => {
    const n = Number(x);
    if (!Number.isFinite(n) || n < 0) throw new Error(`${name} must be a non-negative number`);
    return n;
  };
  if (o.bigChangeFiles !== undefined) out.bigChangeFiles = Math.max(1, num(o.bigChangeFiles, 'bigChangeFiles'));
  if (o.spendThresholdUsd !== undefined) out.spendThresholdUsd = num(o.spendThresholdUsd, 'spendThresholdUsd');
  if (o.alwaysAsk !== undefined) out.alwaysAsk = strList(o.alwaysAsk, 'alwaysAsk');
  if (o.neverAsk !== undefined) out.neverAsk = strList(o.neverAsk, 'neverAsk');
  return out;
}
function decrypt(v: string): string {
  if (v.startsWith('enc:')) return safeStorage.decryptString(Buffer.from(v.slice(4), 'base64'));
  return v.replace(/^raw:/, '');
}
function plainSecrets(s: Settings): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(s.secrets)) {
    try {
      out[k] = decrypt(v);
    } catch {
      /* keychain changed */
    }
  }
  return out;
}

let win: BrowserWindow | null = null;
let harness: Harness;
let settings: Settings;
const watched = new Set<string>();
let pendingEvents: SequencedEvent[] = [];
let pendingSignals: LiveSignal[] = [];
let flushTimer: NodeJS.Timeout | null = null;

function agentsDir(): string {
  const packaged = join(process.resourcesPath ?? '', 'agents');
  return app.isPackaged && existsSync(packaged) ? packaged : join(app.getAppPath(), 'resources', 'agents');
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (!win || win.isDestroyed()) return;
    // Collapse repeated state signals for the same agent into the latest.
    const latest = new Map<string, LiveSignal>();
    const rest: LiveSignal[] = [];
    for (const s of pendingSignals) {
      if (s.t === 'agent.state') latest.set(s.id, s);
      else if (s.t === 'lease.change') latest.set('__leases', s);
      else rest.push(s);
    }
    win.webContents.send('hf:events', { hive: pendingEvents, signals: [...latest.values(), ...rest] });
    pendingEvents = [];
    pendingSignals = [];
  }, 33);
}

async function boot(): Promise<void> {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  settings = loadSettings();
  harness = new Harness({
    home: HOME,
    agentsDir: agentsDir(),
    nodeBin: process.execPath,
    runAsNode: true,
    secrets: plainSecrets(settings),
    llm: { ...settings.llm, apiKey: plainSecrets(settings).HIVE_LLM_API_KEY },
    simSpeed: Number(process.env.HIVEFLOOR_SIM_SPEED || 1)
  });
  await harness.start();
  harness.hive.policy.update(settings.policy);

  harness.bus.on('hive', (se) => {
    pendingEvents.push(se);
    scheduleFlush();
  });
  harness.bus.on('signal', (s) => {
    pendingSignals.push(s);
    scheduleFlush();
  });
  harness.bus.on('pty', (batch) => {
    const out = [];
    for (const item of batch) {
      if (watched.has(item.id)) out.push(item);
      else harness.pty.ack(item.id, item.data.length);
    }
    if (out.length && win && !win.isDestroyed()) win.webContents.send('hf:pty', out);
  });
  harness.bus.on('exit', (e) => win?.webContents.send('hf:exit', e));

  if (!settings.seeded) {
    harness.seedOffice('sim', settings.workspace);
    settings.seeded = true;
    saveSettings(settings);
  }
  if (process.env.HIVEFLOOR_NO_AUTOSTART !== '1') {
    for (const a of harness.hive.listAgents()) {
      harness.startAgent(a.id).catch((e) => console.error(`[start ${a.id}]`, e));
    }
  }
}

// Whitelisted API exposed to the renderer.
const api: Record<string, (...args: never[]) => unknown> = {
  init: () => ({
    home: HOME,
    backend: harness.pty.backend,
    agents: harness.hive.listAgents(),
    states: harness.allStates(),
    messages: harness.hive.recentMessages(500),
    tasks: harness.hive.listTasks(),
    approvals: harness.hive.listApprovals(),
    memory: harness.hive.memory.all().slice(0, 2000),
    board: harness.hive.getBoard(),
    leases: harness.hive.listLeases(),
    providers: harness.providers(),
    settings: { ...settings, secrets: Object.keys(settings.secrets) },
    seq: harness.hive.snapshot().seq
  }),
  hire: (raw: Record<string, unknown>) => {
    const { isBoss, ...rest } = (raw ?? {}) as Record<string, unknown>;
    const input = cleanAgentPatch(rest) as Parameters<Harness['hire']>[0];
    if (!input.name || !input.role || !input.provider) throw new Error('name, role and provider are required');
    const spec = harness.hire({ cwd: settings.workspace, ...input, isBoss: isBoss === true });
    void harness.startAgent(spec.id);
    return spec;
  },
  fire: (id: string) => harness.fire(id),
  start: (id: string) => harness.startAgent(id),
  stop: (id: string) => harness.stopAgent(id),
  restart: (id: string) => harness.restartAgent(id),
  updateAgent: (id: string, patch: Record<string, unknown>) => harness.hive.updateAgent(str(id, 'id', 64), cleanAgentPatch(patch)),
  tellBoss: (text: string) => harness.tellBoss(text),
  sendAsHuman: (to: string, subject: string, body: string) => harness.hive.send({ from: 'human', to, subject, body }),
  input: (id: string, data: string) => harness.input(id, data),
  resize: (id: string, cols: number, rows: number) => harness.pty.resize(id, cols, rows),
  watch: (id: string) => {
    watched.add(id);
    harness.pty.flush(); // anything pending is now part of the replay boundary
    return harness.pty.replay(id);
  },
  unwatch: (id: string) => watched.delete(id),
  ack: (acks: [string, number][]) => acks.forEach(([id, n]) => harness.pty.ack(id, n)),
  decide: (id: string, approved: boolean, reason: string) => harness.hive.decide(id, approved, reason),
  remember: (agent: string, text: string, shared: boolean) => harness.hive.remember(agent, text, { shared }),
  forget: (id: string) => harness.hive.forget(id),
  recall: (query: string, agent?: string) => harness.hive.memory.recall(query, { agent, limit: 30 }),
  setBoard: (text: string) => harness.hive.setBoard(text, 'human'),
  route: (task: string) => harness.route(task),
  stats: () => ({ pty: harness.pty.stats(), rpcRequests: harness.server.requests, watched: [...watched] }),
  saveSettings: (patch: { llm?: unknown; policy?: unknown; workspace?: unknown; secrets?: Record<string, unknown> }) => {
    if (patch.llm) settings.llm = cleanLlm(patch.llm);
    if (patch.workspace) settings.workspace = str(patch.workspace, 'workspace', 1000);
    if (patch.policy) {
      settings.policy = { ...settings.policy, ...cleanPolicy(patch.policy) };
      harness.hive.policy.update(settings.policy);
    }
    if (patch.secrets) {
      for (const [k, v] of Object.entries(patch.secrets)) {
        // Secrets become env vars in agent processes: keep names env-safe and never
        // let them override the harness's own variables or the loader (NODE_OPTIONS…).
        if (!SECRET_NAME.test(k) || /^(HIVE_(URL|TOKEN|AGENT|HOME|AGENT_DIR)|PATH|NODE_OPTIONS|ELECTRON_\w+|LD_\w+|DYLD_\w+)$/.test(k)) {
          throw new Error(`"${k}" is not an allowed secret name`);
        }
        if (v === null || v === '') delete settings.secrets[k];
        else if (typeof v !== 'string' || v.length > 10_000) throw new Error(`secret ${k} must be a string`);
        else settings.secrets[k] = encrypt(v);
      }
    }
    saveSettings(settings);
    // New agents pick these up; running ones keep their env until restarted.
    harness.opts.secrets = plainSecrets(settings);
    harness.opts.llm = { ...settings.llm, apiKey: plainSecrets(settings).HIVE_LLM_API_KEY };
    return { ...settings, secrets: Object.keys(settings.secrets) };
  },
  pickFolder: async () => {
    const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : r.filePaths[0];
  }
};

/** Only our own top-level window may call the API (not iframes or navigated-away pages). */
function trustedSender(e: Electron.IpcMainInvokeEvent): boolean {
  if (!win || e.sender !== win.webContents || e.senderFrame !== win.webContents.mainFrame) return false;
  const url = e.senderFrame?.url ?? '';
  const dev = process.env.ELECTRON_RENDERER_URL;
  return dev && !app.isPackaged ? url.startsWith(dev) : url.startsWith('file://');
}

ipcMain.handle('hf:call', async (e, method: unknown, args: unknown) => {
  if (!trustedSender(e)) throw new Error('untrusted sender');
  if (typeof method !== 'string' || !Object.hasOwn(api, method)) throw new Error(`unknown method ${String(method)}`);
  return (api[method] as (...a: unknown[]) => unknown)(...(Array.isArray(args) ? args : []));
});

function createWindow(): void {
  win = new BrowserWindow({
    width: 1480,
    height: 920,
    minWidth: 1000,
    minHeight: 640,
    backgroundColor: '#1b1d23',
    title: 'Hivefloor',
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: true
    }
  });
  // The UI never navigates or opens windows; block both so injected content can't
  // load a remote page that would then inherit the preload bridge.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win?.webContents.getURL()) e.preventDefault();
  });
  win.webContents.session.setPermissionRequestHandler((_wc, _perm, cb) => cb(false));
  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => {
    win = null;
    watched.clear();
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

app.whenReady().then(async () => {
  await boot();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

let quitting = false;
app.on('before-quit', (e) => {
  if (quitting) return;
  quitting = true;
  e.preventDefault();
  harness
    .stop()
    .catch(() => {})
    .finally(() => app.exit(0));
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
