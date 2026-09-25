// Drives the real Electron app: boots the demo office, talks to the boss, approves
// a risky request, and captures screenshots of the floor/terminal/memory/tasks.
const { _electron: electron } = require('playwright');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const OUT = process.env.SHOTS || path.join(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'hivefloor-e2e-'));
  const app = await electron.launch({
    executablePath: require('electron'),
    args: ['--no-sandbox', '--disable-gpu', path.join(__dirname, '..')],
    env: { ...process.env, HIVEFLOOR_HOME: home, HIVEFLOOR_SIM_SPEED: process.env.SPEED || '1.3' }
  });
  const win = await app.firstWindow();
  const errors = [];
  win.on('pageerror', (e) => errors.push(String(e)));
  win.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await win.setViewportSize({ width: 1480, height: 900 });
  await win.waitForSelector('.topbar', { timeout: 20000 });
  await sleep(2500);
  await win.screenshot({ path: path.join(OUT, '01-office-idle.png') });

  // Talk to the boss
  await win.fill('.composer textarea', 'Add a login endpoint to the API and build a dashboard page for it, then write regression tests for the auth flow');
  await win.keyboard.press('Enter');
  await sleep(2600);
  await win.screenshot({ path: path.join(OUT, '02-routing-and-walking.png') });
  await sleep(3500);
  await win.screenshot({ path: path.join(OUT, '03-agents-working.png') });

  // Open a worker terminal
  await win.click('.roster-item:nth-child(3)');
  await sleep(2500);
  await win.screenshot({ path: path.join(OUT, '04-agent-terminal.png') });

  // Risky request → approval
  await win.click('.tabs button:has-text("Boss")');
  await win.fill('.composer textarea', 'Deploy the dashboard to production');
  await win.keyboard.press('Enter');
  await win.waitForSelector('.approvals-btn.hot', { timeout: 20000 });
  await sleep(800);
  await win.screenshot({ path: path.join(OUT, '05-approval-needed.png') });
  await win.click('.approvals-btn');
  await sleep(500);
  await win.screenshot({ path: path.join(OUT, '06-approvals-tab.png') });
  await win.click('.card.approval button.primary');
  await sleep(6000);

  // Wait for completion of everything
  const t0 = Date.now();
  while (Date.now() - t0 < 60000) {
    const active = await win.evaluate(() => document.querySelectorAll('.kcard.st-active').length);
    await win.click('.tabs button:has-text("Tasks")');
    const done = await win.evaluate(() => document.querySelectorAll('.kcard.st-done').length);
    if (done >= 4 && active === 0) break;
    await sleep(1000);
  }
  await sleep(500);
  await win.screenshot({ path: path.join(OUT, '07-tasks-board.png') });
  const tasks = await win.evaluate(() => [...document.querySelectorAll('.kcard')].map((k) => k.className.replace('kcard ', '') + ' | ' + k.querySelector('.kcard-title').textContent + ' | ' + k.querySelector('.kcard-meta').textContent));
  await win.click('.tabs button:has-text("Memory")');
  await sleep(400);
  await win.fill('.memory .search', 'dashboard tests');
  await sleep(700);
  await win.screenshot({ path: path.join(OUT, '08-memory-search.png') });
  await win.click('.tabs button:has-text("Boss")');
  await sleep(600);
  await win.screenshot({ path: path.join(OUT, '09-boss-report.png') });
  const fps = await win.evaluate(() => window.__scene && window.__scene.fps);
  const stats = await win.evaluate(() => window.hf.call('stats'));
  const approvals = await win.evaluate(() => window.hf.call('init').then((d) => d.approvals.map((a) => `${a.agent}:${a.kind}:${a.status}:${a.summary}`)));
  console.log(JSON.stringify({ fps, rpcRequests: stats.rpcRequests, tasks, approvals, errors, home }, null, 2));
  await app.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
