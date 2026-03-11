import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(__dirname, '..');
const DIST_SERVER = path.join(DEMO_DIR, 'dist', 'server.js');

const PORT = 3320;
const BASE_URL = `http://127.0.0.1:${PORT}`;
const RUNS_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'agentvault-demo-smoke-'));

let serverProcess: ChildProcess | undefined;
let browser: Browser | undefined;

async function waitForServer(url: string, timeoutMs = 15_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Server is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function collectMilestoneTitles(page: Page): Promise<string[]> {
  return page.locator('.vault-card__title').evaluateAll((nodes) =>
    nodes.map((node) => node.textContent?.trim() || '').filter(Boolean),
  );
}

describe('demo ui smoke flow', () => {
  beforeAll(async () => {
    if (!fs.existsSync(DIST_SERVER)) {
      throw new Error('packages/agentvault-demo-ui/dist/server.js is missing. Run npm run build first.');
    }

    serverProcess = spawn(process.execPath, [DIST_SERVER], {
      cwd: DEMO_DIR,
      env: {
        ...process.env,
        DEMO_PORT: String(PORT),
        DEMO_BIND_ADDRESS: '127.0.0.1',
        DEMO_RUNS_DIR: RUNS_DIR,
        DEMO_SMOKE_MODE: '1',
      },
      stdio: 'pipe',
    });

    serverProcess.stderr?.on('data', (chunk) => {
      process.stderr.write(chunk);
    });

    serverProcess.stdout?.on('data', (chunk) => {
      process.stdout.write(chunk);
    });

    await waitForServer(`${BASE_URL}/api/status`);
    browser = await chromium.launch({ headless: true });
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill('SIGTERM');
    }
    fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  });

  it('renders the canonical live flow and preserves it in replay', async () => {
    const page = await browser!.newPage();

    await page.goto(BASE_URL);
    await page.waitForSelector('#start-btn');
    await page.click('#start-btn');

    await page.waitForSelector('.receipt-card__verify-btn');
    await page.waitForFunction(() => {
      const statusText = document.getElementById('status-text');
      return statusText?.textContent?.trim() === 'Completed';
    });

    const liveTitles = await collectMilestoneTitles(page);
    expect(liveTitles).toContain('Contract Parameters');
    expect(liveTitles).toContain('Relay Identity & Policy');
    expect(liveTitles.indexOf('Contract Parameters')).toBeLessThan(
      liveTitles.indexOf('Relay Identity & Policy'),
    );
    expect(liveTitles).toContain('Relay session opened');
    expect(liveTitles).toContain('Bob joined session');
    expect(liveTitles).toContain('Alice — session complete');
    const relayPolicyText = await page.locator('.vault-card').filter({ hasText: 'Relay Identity & Policy' }).textContent();
    expect(relayPolicyText).toContain('no_digits');
    expect(relayPolicyText).toContain('no_currency_symbols');

    await page.click('.receipt-card__verify-btn');
    await page.waitForFunction(() => {
      const status = document.querySelector('.receipt-card__verify-status');
      return (status?.textContent || '').includes('Signature valid');
    });

    await page.click('a[href="/replay.html"]');
    await page.waitForSelector('#replay-btn');
    await page.click('#replay-btn');

    await page.waitForFunction(() => {
      const titles = Array.from(document.querySelectorAll('.vault-card__title'));
      return titles.some((node) => node.textContent?.trim() === 'Contract Parameters')
        && titles.some((node) => node.textContent?.trim() === 'Relay Identity & Policy');
    });

    const replayTitles = await collectMilestoneTitles(page);
    expect(replayTitles.indexOf('Contract Parameters')).toBeLessThan(
      replayTitles.indexOf('Relay Identity & Policy'),
    );

    await page.close();
  }, 30_000);
});
