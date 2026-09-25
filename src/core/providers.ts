// Provider registry: how to launch each kind of agent and how to make it hive-aware.
// Every provider gets the same contract: env vars pointing at the control server,
// the `hive` CLI on PATH, and an identity/protocol prompt.

import { join } from 'node:path';
import type { AgentSpec } from './types';

export interface ProviderDef {
  id: string;
  label: string;
  /** Binary looked up on PATH (for availability checks). */
  bin: string;
  /** Needs an API key env var? (shown in settings) */
  keyEnv?: string[];
  /** Can the harness nudge it by typing into its terminal? */
  nudge: 'type' | 'none';
  /** Supports a native Stop hook that drains the inbox (Claude Code). */
  stopHook?: boolean;
  describe: string;
  build(ctx: LaunchContext): { command: string; args: string[]; env?: Record<string, string> };
}

export interface LaunchContext {
  spec: AgentSpec;
  prompt: string; // identity + protocol
  kickoff: string; // first user turn
  identityFile: string;
  agentsDir: string; // bundled agents/*.cjs
  settingsFile?: string; // claude --settings
  node: string; // node binary (Electron runs as node with ELECTRON_RUN_AS_NODE)
  llm: { baseUrl?: string; apiKey?: string; model?: string; api?: string };
}

const isWin = process.platform === 'win32';

export const PROVIDERS: ProviderDef[] = [
  {
    id: 'sim',
    label: 'Demo worker (no keys)',
    bin: '',
    nudge: 'none',
    describe: 'Scripted worker that exercises the whole harness — great for demos and testing.',
    build: (c) => ({ command: c.node, args: [join(c.agentsDir, 'sim-agent.cjs')] })
  },
  {
    id: 'hive-llm',
    label: 'Built-in agent (your key or local model)',
    bin: '',
    nudge: 'none',
    keyEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    describe: 'Lightweight tool-using agent. Works with Ollama, LM Studio, vLLM, OpenAI, Anthropic or any OpenAI-compatible endpoint.',
    build: (c) => ({
      command: c.node,
      args: [join(c.agentsDir, 'llm-agent.cjs')],
      env: {
        HIVE_LLM_BASE_URL: c.llm.baseUrl ?? 'http://localhost:11434/v1',
        HIVE_LLM_MODEL: c.spec.model || c.llm.model || 'qwen2.5-coder:7b',
        HIVE_LLM_API: c.llm.api ?? 'openai',
        ...(c.llm.apiKey ? { HIVE_LLM_API_KEY: c.llm.apiKey } : {})
      }
    })
  },
  {
    id: 'claude',
    label: 'Claude Code',
    bin: 'claude',
    keyEnv: ['ANTHROPIC_API_KEY'],
    nudge: 'type',
    stopHook: true,
    describe: 'Uses your Claude subscription or ANTHROPIC_API_KEY.',
    build: (c) => ({
      command: 'claude',
      args: [
        ...(c.spec.model ? ['--model', c.spec.model] : []),
        '--append-system-prompt',
        c.prompt,
        ...(c.settingsFile ? ['--settings', c.settingsFile] : []),
        c.kickoff
      ]
    })
  },
  {
    id: 'codex',
    label: 'OpenAI Codex CLI',
    bin: 'codex',
    keyEnv: ['OPENAI_API_KEY'],
    nudge: 'type',
    describe: 'Uses your ChatGPT plan or OPENAI_API_KEY.',
    build: (c) => ({
      command: 'codex',
      args: [...(c.spec.model ? ['-m', c.spec.model] : []), `${c.prompt}\n\n${c.kickoff}`]
    })
  },
  {
    id: 'gemini',
    label: 'Gemini CLI',
    bin: 'gemini',
    keyEnv: ['GEMINI_API_KEY'],
    nudge: 'type',
    describe: 'Uses your Google account or GEMINI_API_KEY.',
    build: (c) => ({
      command: 'gemini',
      args: [...(c.spec.model ? ['-m', c.spec.model] : []), '-i', `${c.prompt}\n\n${c.kickoff}`]
    })
  },
  {
    id: 'aider',
    label: 'Aider',
    bin: 'aider',
    keyEnv: ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY'],
    nudge: 'type',
    describe: 'Any model aider supports, including local ones via Ollama.',
    build: (c) => ({
      command: 'aider',
      args: [...(c.spec.model ? ['--model', c.spec.model] : []), '--read', c.identityFile, '--no-auto-commits']
    })
  },
  {
    id: 'opencode',
    label: 'OpenCode',
    bin: 'opencode',
    nudge: 'type',
    describe: 'OpenCode TUI with any configured provider.',
    build: (c) => ({ command: 'opencode', args: [...(c.spec.model ? ['-m', c.spec.model] : [])] })
  },
  {
    id: 'shell',
    label: 'Plain shell',
    bin: isWin ? 'powershell.exe' : process.env.SHELL || 'bash',
    nudge: 'none',
    describe: 'A terminal with the hive CLI on PATH — drive it yourself.',
    build: () => ({ command: isWin ? 'powershell.exe' : process.env.SHELL || 'bash', args: [] })
  },
  {
    id: 'custom',
    label: 'Custom command',
    bin: '',
    nudge: 'type',
    describe: 'Any terminal program. The hive CLI and env are injected.',
    build: (c) => ({ command: c.spec.command || (isWin ? 'cmd.exe' : 'bash'), args: c.spec.args ?? [] })
  }
];

export function getProvider(id: string): ProviderDef {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown provider ${id}`);
  return p;
}

/** The agent-facing contract, injected into every agent's system prompt. */
export function renderIdentity(spec: AgentSpec, roster: AgentSpec[]): string {
  const others = roster
    .filter((a) => a.id !== spec.id)
    .map((a) => `- ${a.id} (${a.name}) — ${a.isBoss ? 'BOSS, ' : ''}${a.role}${a.skills.length ? `; skills: ${a.skills.join(', ')}` : ''}`)
    .join('\n');
  const bossRules = spec.isBoss
    ? `
You are the BOSS of this office. The human talks only to you.
- Break the human's requests into tasks and route each to the best agent:
  \`hive route "<task>"\` suggests who; then \`hive task new "<title>" --to <agent> --spec "<details>"\`
  (this also messages the agent). Do small things yourself.
- Resolve routine questions from agents yourself. Never bother the human for routine work.
- Escalate to the human ONLY for: spending money, deleting things, big/irreversible changes,
  or external communication. Use: \`hive ask <spend|delete|big-change|external> "<summary>" --detail "<why>"\`
  then continue with other work; you will get an inbox message with the decision.
  When approved, create the tasks with \`--approval <approval-id>\` so workers don't ask again.
- Keep the shared plan in the blackboard: \`hive board --append "<line>"\`.
- Report back to the human with \`hive send human "<summary>" --body "<details>"\`.`
    : `
You are a worker. Your boss is \`boss\`. Take tasks from your inbox, do the work, then report:
  \`hive task done <task-id> --result "<what you did>"\` and \`hive send boss "<summary>"\`.
- Before editing files, lease them so no one else edits them at the same time:
  \`hive lease src/foo.ts src/bar/\` … \`hive release\` when done. If a lease is refused,
  message the holder or pick other work.
- Ask peers directly with \`hive send <agent> "<question>"\` — don't guess.
- NEVER spend money, delete data, force-push, or make big architectural changes without
  approval: \`hive ask <spend|delete|big-change|external> "<summary>"\` and wait for the reply.
  Check first with \`hive check "<command>" --task <task-id>\` — tasks the human already approved pass.`;
  return `# Identity
You are ${spec.name} (id: ${spec.id}), ${spec.role}, working in a shared office of AI agents called the hive.
${spec.skills.length ? `Your skills: ${spec.skills.join(', ')}.` : ''}
${bossRules}

# The hive CLI (already on your PATH)
- \`hive inbox\` — read new messages (marks them read). \`hive inbox --all\` for history.
- \`hive send <agent|boss|human|all> "<subject>" --body "<text>" [--reply <msg-id>]\`
- \`hive remember "<fact>" [--shared] [--tags a,b]\` — long-term memory that survives restarts.
- \`hive recall "<query>"\` — search your memories and shared memories. Do this at the start of a task.
- \`hive task list | new | claim <id> | done <id> --result "..."\`
- \`hive status <working|idle|blocked> "<what you're doing>"\` — shows on your avatar.
- \`hive roster\`, \`hive board\`, \`hive lease\`, \`hive release\`, \`hive ask\`

# Coworkers
${others || '- (none yet)'}

# Habits
1. Start every task with \`hive recall\`. 2. Remember durable learnings with \`hive remember\`.
3. Check \`hive inbox\` whenever you finish something. 4. Keep messages short and self-contained.`;
}
