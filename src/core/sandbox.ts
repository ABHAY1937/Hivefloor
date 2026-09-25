// Docker sandbox for agents (specs/003-agent-sandbox). The PTY runs the `docker`
// client; the agent itself runs in a locked-down container that sees only its
// working folder. Pure argument building lives in buildDockerLaunch() so it can be
// unit-tested without Docker.

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export const DEFAULT_SANDBOX_IMAGE = 'hivefloor-agent:1';
/** Paths inside the container. */
export const C = { agents: '/hive/agents', agent: '/hive/agent', bin: '/hive/bin', home: '/hive/home', work: '/work' } as const;
const CONTAINER_PATH = `${C.bin}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

/** Docker image reference; rejects anything that could be parsed as a flag (SR-4). */
const IMAGE_REF = /^[a-z0-9][a-z0-9._/-]*(:[\w][\w.-]{0,127})?(@sha256:[a-f0-9]{64})?$/i;
export function validImage(image: string): boolean {
  return image.length <= 255 && IMAGE_REF.test(image);
}

export interface DockerLaunchInput {
  id: string;
  name: string;
  image: string;
  platform: NodeJS.Platform;
  /** Host folder the agent works in. */
  workdir: string;
  /** Extra host folders to mount at the same path (POSIX), e.g. the main repo of a worktree. */
  extraMounts?: string[];
  agentsDir: string;
  agentDir: string;
  binDir: string;
  homeDir: string;
  /** Inner command, already built for container paths. */
  command: string;
  args: string[];
  /** Variables for the container: secrets and tokens pass by name only (SR-3). */
  secretEnv: Record<string, string>;
  /** Non-secret variables, passed as NAME=value. */
  plainEnv: Record<string, string>;
  /** uid:gid to run as on Linux, so files in the mounted folder stay owned by the operator. */
  user?: string;
  limits?: { memory?: string; cpus?: string; pids?: number };
  labels?: Record<string, string>;
}

export function containerWorkdir(platform: NodeJS.Platform, hostPath: string): string {
  return platform === 'win32' ? C.work : hostPath;
}

export function buildDockerLaunch(i: DockerLaunchInput): { command: string; args: string[]; clientEnv: Record<string, string> } {
  if (!validImage(i.image)) throw new Error(`invalid sandbox image "${i.image}"`);
  const wd = containerWorkdir(i.platform, i.workdir);
  const mount = (src: string, dst: string, ro = false) => {
    // --mount is comma-separated; a comma in a path would smuggle extra options.
    if (/[,\n]/.test(src) || /[,\n]/.test(dst)) throw new Error(`sandbox cannot mount a path containing a comma: ${src}`);
    return ['--mount', `type=bind,source=${src},target=${dst}${ro ? ',readonly' : ''}`];
  };
  const labels = { 'dev.hivefloor': '1', 'dev.hivefloor.agent': i.id, ...(i.labels ?? {}) };
  const args = [
    'run', '--rm', '-it', '--init',
    '--name', i.name,
    ...Object.entries(labels).flatMap(([k, v]) => ['--label', `${k}=${v}`]),
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--pids-limit', String(i.limits?.pids ?? 1024),
    '--memory', i.limits?.memory ?? '4g',
    '--cpus', i.limits?.cpus ?? '2',
    ...(i.platform === 'linux' ? ['--add-host', 'host.docker.internal:host-gateway'] : []),
    ...(i.user ? ['--user', i.user] : []),
    ...mount(i.workdir, wd),
    ...(i.platform === 'win32' ? [] : (i.extraMounts ?? []).filter((m) => m !== i.workdir).flatMap((m) => mount(m, m))),
    ...mount(i.agentsDir, C.agents, true),
    ...mount(i.agentDir, C.agent, true),
    ...mount(i.binDir, C.bin, true),
    ...mount(i.homeDir, C.home),
    '-w', wd,
    ...Object.entries({ HOME: C.home, PATH: CONTAINER_PATH, ...i.plainEnv }).flatMap(([k, v]) => ['-e', `${k}=${v}`]),
    ...Object.keys(i.secretEnv).flatMap((k) => ['-e', k]),
    i.image,
    i.command,
    ...i.args
  ];
  return { command: 'docker', args, clientEnv: i.secretEnv };
}

/** Rewrite loopback URLs so a containerised agent reaches services on the host. */
export function hostUrl(url: string): string {
  return url.replace(/^(\w+:\/\/)(localhost|127\.0\.0\.1|\[::1\])(?=[:/]|$)/i, '$1host.docker.internal');
}

/** The `hive` shim used inside containers. */
export function writeContainerShim(binDir: string): void {
  mkdirSync(binDir, { recursive: true });
  const p = join(binDir, 'hive');
  writeFileSync(p, `#!/bin/sh\nexec node ${C.agents}/hive-cli.cjs "$@"\n`);
  try {
    chmodSync(p, 0o755);
  } catch {
    /* windows host: Docker Desktop mounts files executable */
  }
}

/** Short stable id for this hive home, so cleanup only touches our own containers. */
export function homeLabel(home: string): string {
  return createHash('sha256').update(home).digest('hex').slice(0, 12);
}

/** Throws a user-facing reason when the sandbox can't run: no daemon, or Windows-containers mode. */
export async function checkDocker(): Promise<void> {
  let os: string;
  try {
    ({ stdout: os } = await pexec('docker', ['version', '--format', '{{.Server.Os}}'], { timeout: 10_000 }));
  } catch {
    throw new Error('Docker is not running — start Docker Desktop (or Docker Engine) to use the sandbox');
  }
  if (os.trim() !== 'linux') {
    throw new Error(`Docker is in ${os.trim()}-containers mode; the sandbox needs Linux containers (Docker Desktop → Switch to Linux containers)`);
  }
}

/** Build the default image on first use; custom images must already exist. */
export async function ensureImage(image: string, sandboxDir: string, log: (s: string) => void): Promise<void> {
  try {
    await pexec('docker', ['image', 'inspect', image], { timeout: 20_000 });
    return;
  } catch {
    /* missing */
  }
  if (image !== DEFAULT_SANDBOX_IMAGE) throw new Error(`sandbox image ${image} not found — run: docker pull ${image}`);
  log(`building sandbox image ${image} (first time only, a few minutes)…`);
  await pexec('docker', ['build', '-t', image, sandboxDir], { timeout: 30 * 60_000, maxBuffer: 64 * 1024 * 1024 });
  log(`sandbox image ${image} ready`);
}

/** Linux: the docker0 bridge gateway, where the control server must also listen. */
export async function bridgeGateway(): Promise<string> {
  const { stdout } = await pexec('docker', ['network', 'inspect', 'bridge', '--format', '{{(index .IPAM.Config 0).Gateway}}'], { timeout: 10_000 });
  const ip = stdout.trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(ip)) throw new Error(`unexpected docker bridge gateway "${ip}"`);
  return ip;
}

export async function removeContainers(filter: { name?: string; label?: string }): Promise<void> {
  try {
    if (filter.name) {
      await pexec('docker', ['rm', '-f', filter.name], { timeout: 20_000 });
      return;
    }
    const { stdout } = await pexec('docker', ['ps', '-aq', '--filter', `label=${filter.label}`], { timeout: 20_000 });
    const ids = stdout.split(/\s+/).filter(Boolean);
    if (ids.length) await pexec('docker', ['rm', '-f', ...ids], { timeout: 30_000 });
  } catch {
    /* already gone, or docker not running */
  }
}
