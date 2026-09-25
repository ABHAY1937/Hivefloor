// specs/003-agent-sandbox. Unit tests always run; the integration test runs only
// where a Docker daemon is reachable (Linux CI has one; set HIVEFLOOR_DOCKER_TESTS=0 to skip).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Harness } from '../src/core/harness';
import { buildDockerLaunch, hostUrl, validImage, type DockerLaunchInput } from '../src/core/sandbox';

const agentsDir = resolve(__dirname, '../resources/agents');

const input = (over: Partial<DockerLaunchInput> = {}): DockerLaunchInput => ({
  id: 'ada',
  name: 'hivefloor-x-ada-1',
  image: 'hivefloor-agent:1',
  platform: 'linux',
  workdir: '/home/me/proj',
  agentsDir: '/opt/hivefloor/agents',
  agentDir: '/home/me/.hivefloor/hive/agents/ada',
  binDir: '/home/me/.hivefloor/sandbox/bin',
  homeDir: '/home/me/.hivefloor/sandbox/ada/home',
  command: 'claude',
  args: ['--append-system-prompt', 'hi'],
  secretEnv: { HIVE_TOKEN: 'tok-SECRET', ANTHROPIC_API_KEY: 'sk-ant-SECRET' },
  plainEnv: { HIVE_URL: 'http://host.docker.internal:4000', HIVE_AGENT: 'ada' },
  user: '1000:1000',
  ...over
});

test('docker launch: locked down, secrets by name only, only the workdir mounted', () => {
  const { command, args, clientEnv } = buildDockerLaunch(input());
  const line = args.join(' ');
  assert.equal(command, 'docker');
  for (const flag of ['--rm', '--init', '--cap-drop ALL', '--security-opt no-new-privileges', '--pids-limit', '--memory', '--cpus', '--user 1000:1000']) {
    assert.ok(line.includes(flag), `missing ${flag}`);
  }
  assert.ok(!line.includes('SECRET'), 'secret values must never be on the command line (visible in ps)');
  assert.ok(args.includes('HIVE_TOKEN') && args.includes('ANTHROPIC_API_KEY'), 'secrets pass by name');
  assert.equal(clientEnv.ANTHROPIC_API_KEY, 'sk-ant-SECRET', 'the docker client forwards them from its env');
  const mounts = args.filter((_, i) => args[i - 1] === '--mount');
  assert.deepEqual(
    mounts.map((m) => m.split(',')[1].replace('source=', '')),
    ['/home/me/proj', '/opt/hivefloor/agents', '/home/me/.hivefloor/hive/agents/ada', '/home/me/.hivefloor/sandbox/bin', '/home/me/.hivefloor/sandbox/ada/home'],
    'nothing but the workdir, agent scripts, identity, shim and private home'
  );
  assert.ok(mounts[1].endsWith(',readonly') && mounts[2].endsWith(',readonly') && mounts[3].endsWith(',readonly'));
  assert.ok(line.includes('--add-host host.docker.internal:host-gateway'));
  const img = args.indexOf('hivefloor-agent:1');
  assert.deepEqual(args.slice(img), ['hivefloor-agent:1', 'claude', '--append-system-prompt', 'hi'], 'inner command follows the image');
});

test('docker launch: Windows paths map to /work, flag-shaped images and comma paths are refused', () => {
  const win = buildDockerLaunch(input({ platform: 'win32', workdir: 'C:\\Users\\me\\proj', user: undefined }));
  assert.ok(win.args.includes('type=bind,source=C:\\Users\\me\\proj,target=/work'));
  assert.equal(win.args[win.args.indexOf('-w') + 1], '/work');
  assert.ok(!win.args.includes('--add-host'), 'Docker Desktop provides host.docker.internal itself');
  for (const bad of ['--privileged', '-v/:/host', 'img --privileged', 'a;b', '']) assert.equal(validImage(bad), false, bad);
  for (const ok of ['hivefloor-agent:1', 'node:24-bookworm-slim', 'ghcr.io/org/agent:v2', `alpine@sha256:${'a'.repeat(64)}`]) assert.equal(validImage(ok), true, ok);
  assert.throws(() => buildDockerLaunch(input({ image: '--privileged' })), /invalid sandbox image/);
  assert.throws(() => buildDockerLaunch(input({ workdir: '/tmp/a,target=/etc' })), /comma/);
});

test('loopback model URLs are rewritten for containers', () => {
  assert.equal(hostUrl('http://localhost:11434/v1'), 'http://host.docker.internal:11434/v1');
  assert.equal(hostUrl('http://127.0.0.1:1234'), 'http://host.docker.internal:1234');
  assert.equal(hostUrl('https://api.anthropic.com'), 'https://api.anthropic.com');
  assert.equal(hostUrl('http://localhost.evil.com'), 'http://localhost.evil.com');
});

function dockerUp(): boolean {
  if (process.env.HIVEFLOOR_DOCKER_TESTS === '0') return false;
  try {
    // Windows CI runners have Docker in Windows-containers mode, which can't run the Linux sandbox.
    return execFileSync('docker', ['version', '--format', '{{.Server.Os}}'], { encoding: 'utf8', stdio: 'pipe', timeout: 15_000 }).trim() === 'linux';
  } catch {
    return false;
  }
}

const IMAGE = 'node:24-bookworm-slim';

test('integration: a sandboxed agent works through the hive but is walled off from the host', { skip: !dockerUp() && 'Docker (Linux containers) not available', timeout: 300_000 }, async () => {
  execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'pipe', timeout: 240_000 });
  const home = mkdtempSync(join(tmpdir(), 'hf-box-'));
  const work = mkdtempSync(join(tmpdir(), 'hf-work-'));
  writeFileSync(join(work, 'README.md'), 'inside');
  const outside = mkdtempSync(join(tmpdir(), 'hf-outside-'));
  writeFileSync(join(outside, 'secret.txt'), 'host-only');
  const h = new Harness({ home, agentsDir, secrets: { ANTHROPIC_API_KEY: 'sk-ant-test', GITHUB_TOKEN: 'gh-test' } });
  await h.start();
  try {
    h.hire({ name: 'Boss', role: 'boss', provider: 'sim', isBoss: true });
    const probe = [
      'test -f README.md && echo WORK_OK',
      `test -e ${JSON.stringify(outside.replace(/\\/g, '/'))}/secret.txt && echo HOST_LEAK || echo HOST_HIDDEN`,
      'test -n "$GITHUB_TOKEN" && echo GH_LEAK || echo GH_HIDDEN',
      // Every mount point the container has, minus the kernel/runtime ones.
      "echo MOUNTS: $(awk '{print $5}' /proc/self/mountinfo | grep -vE '^/(proc|sys|dev)(/|$)|^/etc/(hostname|hosts|resolv.conf)$|^(/usr)?/sbin/docker-init$' | sort -u | tr '\\n' ' ') :END",
      'hive remember "sandbox says hi" --shared',
      'hive send boss "from the box"',
      'sleep 60'
    ].join('; ');
    const a = h.hire({ name: 'Boxy', role: 'dev', provider: 'custom', command: 'sh', args: ['-c', probe], cwd: work, sandbox: 'docker', sandboxImage: IMAGE });
    let out = '';
    h.bus.on('pty', (b) => b.forEach((x) => x.id === a.id && (out += x.data)));
    await h.startAgent(a.id);
    const t0 = Date.now();
    while (!/remembered/.test(out) || h.hive.unreadCount('boss') === 0) {
      if (Date.now() - t0 > 120_000) throw new Error(`timeout; output:\n${out}`);
      await new Promise((r) => setTimeout(r, 200));
    }
    assert.match(out, /WORK_OK/, 'the working folder is mounted');
    assert.match(out, /HOST_HIDDEN/, 'files outside the working folder are invisible');
    assert.match(out, /GH_HIDDEN/, 'ungranted secrets do not reach the container');
    const mounts = /MOUNTS: (.*?) :END/.exec(out.replace(/\r?\n/g, ' '))?.[1].trim().split(/\s+/).sort();
    const wd = process.platform === 'win32' ? '/work' : work;
    assert.deepEqual(mounts, ['/', '/hive/agent', '/hive/agents', '/hive/bin', '/hive/home', wd].sort(), 'no host path is mounted besides the working folder');
    assert.equal(h.hive.inbox('boss')[0].from, a.id, 'the hive round-trip is authenticated');
    assert.equal(h.hive.memory.recall('sandbox says hi')[0]?.entry.agent, a.id);
    const running = () => execFileSync('docker', ['ps', '-q', '--filter', `label=dev.hivefloor.agent=${a.id}`], { encoding: 'utf8' }).trim();
    assert.ok(running(), 'container is running');
    await h.stop();
    assert.equal(running(), '', 'container is removed on stop');
  } finally {
    await h.stop().catch(() => {});
  }
});
