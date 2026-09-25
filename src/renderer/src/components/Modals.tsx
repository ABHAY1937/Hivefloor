import { useEffect, useState } from 'react';
import { call, select, store, useStore, type SettingsView } from '../store';

function Modal({ title, children, onClose }: { title: string; children: React.ReactNode; onClose: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={onClose}>
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="ghost icon" onClick={onClose}>✕</button>
        </div>
        {children}
      </div>
    </div>
  );
}

/** Which stored keys an agent gets: its engine's own automatically, others only if ticked. */
export function AgentKeys({ provider, value, onChange }: { provider: string; value: string[]; onChange: (v: string[]) => void }) {
  const providers = useStore((s) => s.providers);
  const settings = useStore((s) => s.settings);
  const auto = providers.find((p) => p.id === provider)?.keyEnv ?? [];
  const extra = (settings?.secrets ?? []).filter((k) => !auto.includes(k) && k !== 'HIVE_LLM_API_KEY');
  return (
    <label>
      Keys this agent can use
      <span className="hint">
        {auto.length ? <>From its engine, automatically: {auto.map((k) => <code key={k}>{k}</code>)}. </> : 'Its engine needs no stored key. '}
        No other stored key reaches this agent unless you tick it.
      </span>
      {extra.length ? (
        <div className="chips">
          {extra.map((k) => (
            <button type="button" key={k} className={`chip ${value.includes(k) ? 'on' : ''}`} onClick={() => onChange(value.includes(k) ? value.filter((x) => x !== k) : [...value, k])}>
              {value.includes(k) ? '✓ ' : ''}{k}
            </button>
          ))}
        </div>
      ) : (
        <span className="hint">Add other keys (e.g. GITHUB_TOKEN) in Settings → API keys to grant them here.</span>
      )}
    </label>
  );
}

/** Where the agent runs: on this machine, or in a locked-down Docker container. */
export function SandboxField({ sandbox, image, onChange }: { sandbox: 'none' | 'docker'; image: string; onChange: (v: { sandbox: 'none' | 'docker'; image: string }) => void }) {
  return (
    <label>
      Sandbox
      <select value={sandbox} onChange={(e) => onChange({ sandbox: e.target.value as 'none' | 'docker', image })}>
        <option value="none">None: runs on this machine as you</option>
        <option value="docker">Docker container: sees only its working folder (recommended for untrusted code)</option>
      </select>
      {sandbox === 'docker' && (
        <>
          <input value={image} placeholder="hivefloor-agent:1 (built automatically on first start)" onChange={(e) => onChange({ sandbox, image: e.target.value.trim() })} />
          <span className="hint">Needs Docker Desktop or Docker Engine running. No capabilities, no privilege escalation, memory/CPU/process limits; CLI logins are kept per agent, separate from your home folder.</span>
        </>
      )}
    </label>
  );
}

const ROLES = [
  { name: 'Backend engineer', skills: 'api, database, sql, node, python, auth, server' },
  { name: 'Frontend engineer', skills: 'react, ui, css, design, component, page, dashboard' },
  { name: 'QA & test engineer', skills: 'test, testing, bug, regression, coverage, e2e' },
  { name: 'DevOps & infra', skills: 'deploy, production, docker, infra, pipeline, cloud, release, monitoring, ci' },
  { name: 'Researcher', skills: 'research, docs, compare, investigate, summarize' },
  { name: 'Data engineer', skills: 'data, etl, pipeline, analytics, sql, warehouse' }
];

export function HireModal() {
  const providers = useStore((s) => s.providers);
  const agents = useStore((s) => s.agents);
  const settings = useStore((s) => s.settings);
  const hasBoss = Object.values(agents).some((a) => a.isBoss);
  const [f, setF] = useState({
    name: '',
    role: ROLES[0].name,
    skills: ROLES[0].skills,
    provider: 'sim',
    model: '',
    cwd: settings?.workspace ?? '',
    isolation: 'shared' as 'shared' | 'worktree',
    isBoss: !hasBoss,
    command: '',
    secrets: [] as string[],
    sandbox: 'none' as 'none' | 'docker',
    sandboxImage: ''
  });
  const [err, setErr] = useState('');
  const close = () => store.set({ modal: null });
  const hire = async () => {
    setErr('');
    try {
      const spec = await call<{ id: string }>('hire', {
        name: f.name.trim() || 'Agent',
        role: f.isBoss ? 'Boss / orchestrator' : f.role,
        skills: f.skills.split(',').map((s) => s.trim()).filter(Boolean),
        provider: f.provider,
        model: f.model || undefined,
        cwd: f.cwd || undefined,
        isolation: f.isolation,
        isBoss: f.isBoss,
        command: f.command || undefined,
        secrets: f.secrets,
        sandbox: f.sandbox,
        sandboxImage: f.sandboxImage || undefined
      });
      close();
      select(spec.id);
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    }
  };
  const p = providers.find((x) => x.id === f.provider);
  return (
    <Modal title="Hire an agent" onClose={close}>
      <div className="form">
        <div className="row">
          <label className="grow">Name<input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="e.g. Priya" /></label>
          <label className="check"><input type="checkbox" checked={f.isBoss} disabled={hasBoss} onChange={(e) => setF({ ...f, isBoss: e.target.checked })} /> Boss (the one you talk to){hasBoss ? ' — already hired' : ''}</label>
        </div>
        {!f.isBoss && (
          <>
            <label>
              Role
              <select value={f.role} onChange={(e) => { const r = ROLES.find((x) => x.name === e.target.value)!; setF({ ...f, role: r.name, skills: r.skills }); }}>
                {ROLES.map((r) => <option key={r.name}>{r.name}</option>)}
              </select>
            </label>
            <label>Skills — the boss routes by these<input value={f.skills} onChange={(e) => setF({ ...f, skills: e.target.value })} /></label>
          </>
        )}
        <label>
          Engine
          <div className="provider-grid">
            {providers.map((x) => (
              <button type="button" key={x.id} className={`provider ${f.provider === x.id ? 'on' : ''}`} onClick={() => setF({ ...f, provider: x.id })}>
                <b>{x.label}</b>
                <span>{x.describe}</span>
              </button>
            ))}
          </div>
        </label>
        {p && p.bin && (
          <div className="hint">
            {f.sandbox === 'docker' ? <>Runs <code>{p.bin}</code> inside the sandbox image (the default image includes Claude Code, Codex and Gemini CLI)</> : <>Requires <code>{p.bin}</code> on your PATH</>}
            {p.keyEnv.length ? ` and a login or ${p.keyEnv.join(' / ')} (Settings → Keys)` : ''}.
          </div>
        )}
        <div className="row">
          <label className="grow">Model (optional)<input value={f.model} onChange={(e) => setF({ ...f, model: e.target.value })} placeholder={f.provider === 'hive-llm' ? settings?.llm.model : 'provider default'} /></label>
          {f.provider === 'custom' && <label className="grow">Command<input value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder="e.g. my-agent --tui" /></label>}
        </div>
        <label>
          Working folder
          <div className="row">
            <input value={f.cwd} onChange={(e) => setF({ ...f, cwd: e.target.value })} />
            <button type="button" className="ghost" onClick={async () => { const d = await call<string | null>('pickFolder'); if (d) setF({ ...f, cwd: d }); }}>Browse</button>
          </div>
        </label>
        <label>
          Isolation
          <select value={f.isolation} onChange={(e) => setF({ ...f, isolation: e.target.value as 'shared' | 'worktree' })}>
            <option value="shared">Shared folder — agents coordinate with file leases</option>
            <option value="worktree">Own git worktree + branch — zero collisions (git repos only)</option>
          </select>
        </label>
        <SandboxField sandbox={f.sandbox} image={f.sandboxImage} onChange={(v) => setF({ ...f, sandbox: v.sandbox, sandboxImage: v.image })} />
        <AgentKeys provider={f.provider} value={f.secrets} onChange={(secrets) => setF({ ...f, secrets })} />
        {err && <div className="error">{err}</div>}
        <div className="row end">
          <button className="ghost" onClick={close}>Cancel</button>
          <button className="primary" onClick={() => void hire()}>Hire & start</button>
        </div>
      </div>
    </Modal>
  );
}

const PRESETS = [
  { label: 'Ollama (local)', baseUrl: 'http://localhost:11434/v1', api: 'openai', model: 'qwen2.5-coder:7b' },
  { label: 'LM Studio (local)', baseUrl: 'http://localhost:1234/v1', api: 'openai', model: 'local-model' },
  { label: 'vLLM (local)', baseUrl: 'http://localhost:8000/v1', api: 'openai', model: 'Qwen/Qwen2.5-Coder-7B-Instruct' },
  { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', api: 'openai', model: 'gpt-4.1-mini' },
  { label: 'Anthropic', baseUrl: 'https://api.anthropic.com', api: 'anthropic', model: 'claude-sonnet-4-5' },
  { label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', api: 'openai', model: 'qwen/qwen-2.5-coder-32b-instruct' }
] as const;

const KEYS = [
  { env: 'HIVE_LLM_API_KEY', label: 'Built-in agent key (for the endpoint above)' },
  { env: 'ANTHROPIC_API_KEY', label: 'Anthropic (Claude Code, Aider)' },
  { env: 'OPENAI_API_KEY', label: 'OpenAI (Codex, Aider)' },
  { env: 'GEMINI_API_KEY', label: 'Google Gemini CLI' }
];

export function SettingsModal() {
  const settings = useStore((s) => s.settings)!;
  const home = useStore((s) => s.home);
  const backend = useStore((s) => s.backend);
  const [llm, setLlm] = useState(settings.llm);
  const [policy, setPolicy] = useState({
    spendThresholdUsd: settings.policy.spendThresholdUsd ?? 0,
    bigChangeFiles: settings.policy.bigChangeFiles ?? 25,
    alwaysAsk: (settings.policy.alwaysAsk ?? []).join('\n')
  });
  const [workspace, setWorkspace] = useState(settings.workspace);
  const [keys, setKeys] = useState<Record<string, string>>({});
  const [custom, setCustom] = useState({ name: '', value: '' });
  const [err, setErr] = useState('');
  const [stats, setStats] = useState<{ pty: { id: string; bytes: number; paused: boolean }[]; rpcRequests: number } | null>(null);
  const [saved, setSaved] = useState(false);
  const close = () => store.set({ modal: null });
  useEffect(() => {
    void call<typeof stats>('stats').then(setStats);
  }, []);
  const save = async () => {
    const secrets: Record<string, string | null> = {};
    for (const [k, v] of Object.entries(keys)) secrets[k] = v;
    if (custom.name.trim() && custom.value) secrets[custom.name.trim().toUpperCase()] = custom.value;
    setErr('');
    let next: SettingsView;
    try {
      next = await call<SettingsView>('saveSettings', {
        llm,
        workspace,
        secrets,
        policy: {
          spendThresholdUsd: Number(policy.spendThresholdUsd) || 0,
          bigChangeFiles: Number(policy.bigChangeFiles) || 25,
          alwaysAsk: policy.alwaysAsk.split('\n').map((s) => s.trim()).filter(Boolean)
        }
      });
    } catch (e) {
      setErr((e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
      return;
    }
    store.set({ settings: next });
    setKeys({});
    setCustom({ name: '', value: '' });
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };
  return (
    <Modal title="Settings" onClose={close}>
      <div className="form">
        <div className="section-title">Built-in agent model (your key or local model)</div>
        <div className="chips">
          {PRESETS.map((p) => (
            <button key={p.label} className={`chip ${llm.baseUrl === p.baseUrl ? 'on' : ''}`} onClick={() => setLlm({ baseUrl: p.baseUrl, api: p.api, model: p.model })}>{p.label}</button>
          ))}
        </div>
        <div className="row">
          <label className="grow">Base URL<input value={llm.baseUrl} onChange={(e) => setLlm({ ...llm, baseUrl: e.target.value })} /></label>
          <label>API
            <select value={llm.api} onChange={(e) => setLlm({ ...llm, api: e.target.value as 'openai' | 'anthropic' })}>
              <option value="openai">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
            </select>
          </label>
          <label className="grow">Default model<input value={llm.model} onChange={(e) => setLlm({ ...llm, model: e.target.value })} /></label>
        </div>

        <div className="section-title">API keys — encrypted with your OS keychain; each agent gets only its engine's keys plus the ones you tick for it</div>
        {KEYS.map((k) => (
          <label key={k.env}>
            {k.label} <code>{k.env}</code> {settings.secrets.includes(k.env) && <span className="tag gold">saved</span>}
            <div className="row">
              <input type="password" value={keys[k.env] ?? ''} placeholder={settings.secrets.includes(k.env) ? '•••••••• (leave blank to keep)' : 'not set'} onChange={(e) => setKeys({ ...keys, [k.env]: e.target.value })} />
              {settings.secrets.includes(k.env) && <button className="ghost" onClick={() => setKeys({ ...keys, [k.env]: '' })}>Clear</button>}
            </div>
          </label>
        ))}
        {settings.secrets.filter((k) => !KEYS.some((x) => x.env === k)).map((k) => (
          <div key={k} className="row">
            <code className="grow">{k}</code> <span className="tag gold">saved</span>
            <button className="ghost" onClick={() => setKeys({ ...keys, [k]: '' })}>{keys[k] === '' ? 'Will be removed' : 'Remove'}</button>
          </div>
        ))}
        <label>
          Add another key (e.g. GITHUB_TOKEN), then grant it per agent in Hire / Setup
          <div className="row">
            <input placeholder="NAME" value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_') })} />
            <input className="grow" type="password" placeholder="value" value={custom.value} onChange={(e) => setCustom({ ...custom, value: e.target.value })} />
          </div>
        </label>

        <div className="section-title">When should agents ask you?</div>
        <div className="row">
          <label className="grow">Ask for any spend at or above ($, 0 = always)<input type="number" min={0} value={policy.spendThresholdUsd} onChange={(e) => setPolicy({ ...policy, spendThresholdUsd: Number(e.target.value) })} /></label>
          <label className="grow">A change is “big” at (files)<input type="number" min={1} value={policy.bigChangeFiles} onChange={(e) => setPolicy({ ...policy, bigChangeFiles: Number(e.target.value) })} /></label>
        </div>
        <label>Always ask when a command or plan matches (one regex per line)<textarea rows={3} value={policy.alwaysAsk} onChange={(e) => setPolicy({ ...policy, alwaysAsk: e.target.value })} placeholder={'terraform apply\nkubectl delete'} /></label>
        <div className="hint">Deletions (rm -rf, DROP TABLE, force-push…), spending, publishing/production deploys and external messages always need your approval.</div>

        <div className="section-title">Workspace</div>
        <label>
          Default folder for new agents
          <div className="row">
            <input value={workspace} onChange={(e) => setWorkspace(e.target.value)} />
            <button className="ghost" onClick={async () => { const d = await call<string | null>('pickFolder'); if (d) setWorkspace(d); }}>Browse</button>
          </div>
        </label>
        <div className="hint">
          Data lives in <code>{home}</code> (hive log, snapshots, per-agent memory.md). Terminal backend: <b>{backend}</b>.
          {stats && <> Control-server requests: {stats.rpcRequests}. PTY sessions: {stats.pty.length} ({stats.pty.map((p) => `${p.id} ${(p.bytes / 1024).toFixed(0)}KB${p.paused ? ' paused' : ''}`).join(', ')}).</>}
        </div>
        {err && <div className="error">{err}</div>}
        <div className="row end">
          {saved && <span className="ok">Saved — restart agents to apply new keys/models</span>}
          <button className="ghost" onClick={close}>Close</button>
          <button className="primary" onClick={() => void save()}>Save</button>
        </div>
      </div>
    </Modal>
  );
}
