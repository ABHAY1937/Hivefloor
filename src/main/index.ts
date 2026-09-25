// Electron main: a thin shell around the core Harness. All state lives in the
// harness; this file owns windows, settings/keys, and the IPC bridge.
//
// IPC design for performance:
//  - One invoke channel ('hf:call') with a whitelisted method table.
//  - Hive events + live signals are coalesced and pushed ~30x/s on 'hf:events'.
//  - PTY output is forwarded ONLY for terminals the UI is actually showing
//    ("watched"); unwatched sessions are auto-acked in main and replayed from
//    the ring buffer when opened. 20 agents cost the same IPC as 1 visible one.

import { app, BrowserWindow, ipcMain, safeStorage, shell, dialog } from 'electron';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Harness } from '../core/harness';
import type { LiveSignal, SequencedEvent } from '../core/types';
import type { PolicyConfig } from '../core/policy';
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
  writeAtomicSync(SETTINGS_PATH, JSON.stringify(s, null, 2));
}
function encrypt(v: string): string {
  return safeStorage.isEncryptionAvailable() ? `enc:${safeStorage.encryptString(v).toString('base64')}` : `raw:${v}`;
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
  mkdirSync(HOME, { recursive: true });
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
  hire: (input: Parameters<Harness['hire']>[0]) => {
    const spec = harness.hire({ cwd: settings.workspace, ...input });
    void harness.startAgent(spec.id);
    return spec;
  },
  fire: (id: string) => harness.fire(id),
  start: (id: string) => harness.startAgent(id),
  stop: (id: string) => harness.stopAgent(id),
  restart: (id: string) => harness.restartAgent(id),
  updateAgent: (id: string, patch: Record<string, unknown>) => harness.hive.updateAgent(id, patch),
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
  saveSettings: (patch: { llm?: Settings['llm']; policy?: Partial<PolicyConfig>; workspace?: string; secrets?: Record<string, string | null> }) => {
    if (patch.llm) settings.llm = patch.llm;
    if (patch.workspace) settings.workspace = patch.workspace;
    if (patch.policy) {
      settings.policy = { ...settings.policy, ...patch.policy };
      harness.hive.policy.update(settings.policy);
    }
    if (patch.secrets) {
      for (const [k, v] of Object.entries(patch.secrets)) {
        if (v === null || v === '') delete settings.secrets[k];
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
  },
  openPath: (p: string) => shell.openPath(p)
};

ipcMain.handle('hf:call', async (_e, method: string, args: unknown[]) => {
  const fn = api[method];
  if (!fn) throw new Error(`unknown method ${method}`);
  return (fn as (...a: unknown[]) => unknown)(...(args ?? []));
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
      sandbox: false,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });
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
