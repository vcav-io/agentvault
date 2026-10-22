import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { DEMO_PROVIDER_OPTIONS, HEARTBEAT_DEFAULTS } from './demo-config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEMO_DIR = path.resolve(__dirname, '..');
const REPO_ROOT = path.resolve(DEMO_DIR, '../..');

function readRepoFile(...parts: string[]): string {
  return fs.readFileSync(path.join(REPO_ROOT, ...parts), 'utf8');
}

function composePublishedPorts(compose: string): string[] {
  const published: string[] = [];
  let inPorts = false;
  for (const line of compose.split('\n')) {
    if (/^\s*ports:\s*$/.test(line)) {
      inPorts = true;
      continue;
    }
    if (inPorts) {
      const item = /^\s*-\s*["']?([^"'\s]+)["']?\s*$/.exec(line);
      if (item) {
        published.push(item[1]);
        continue;
      }
      if (/^\s*#/.test(line)) continue;
      inPorts = false;
    }
  }
  return published;
}

describe('demo guardrails', () => {
  it('publishes demo compose ports on host loopback only', () => {
    const compose = readRepoFile('docker', 'docker-compose.demo.yml');
    const published = composePublishedPorts(compose);
    expect(published).toEqual(['127.0.0.1:3100:3100', '127.0.0.1:3200:3200']);
    // Services listen on all interfaces inside their containers so they can
    // reach each other on the compose network; exposure is set by publishing.
    expect(compose).toContain('SELKEY_BIND_ADDR=0.0.0.0');
    expect(compose).toContain('DEMO_BIND_ADDRESS=0.0.0.0');
  });

  it('defaults the demo server to loopback', () => {
    const server = readRepoFile('packages', 'selkey-demo-ui', 'src', 'server.ts');
    expect(server).toContain("process.env['DEMO_BIND_ADDRESS'] ?? '127.0.0.1'");
  });

  it('builds selkey client before selkey-mcp in run.sh', () => {
    const script = readRepoFile('packages', 'selkey-demo-ui', 'run.sh');
    expect(script.indexOf('Building selkey client...')).toBeGreaterThan(-1);
    expect(script.indexOf('Building selkey-mcp...')).toBeGreaterThan(-1);
    expect(script.indexOf('Building selkey client...')).toBeLessThan(
      script.indexOf('Building selkey-mcp...'),
    );
  });

  it('builds contract milestone before relay policy in the start helper', () => {
    const helper = readRepoFile('packages', 'selkey-demo-ui', 'src', 'start-milestones.ts');
    expect(helper).toContain("buildRelayContract('MEDIATION', ['alice', 'bob'], relayProfileId)");
    expect(helper.indexOf("agent: 'contract_enforcement'")).toBeLessThan(
      helper.indexOf("agent: 'relay_policy'"),
    );
  });

  it('keeps docs and UI strings aligned with current demo config', () => {
    const readme = readRepoFile('README.md');
    const gettingStarted = readRepoFile('docs', 'getting-started.md');
    const modelDefaults = readRepoFile('docs', 'model-defaults.md');
    const renderJs = readRepoFile('packages', 'selkey-demo-ui', 'public', 'render.js');

    expect(readme).toContain('Verify Signature');
    expect(readme).not.toContain('Verify Receipt');
    expect(renderJs).toContain('Verify Signature');
    expect(renderJs).not.toContain('Verify Receipt');

    for (const provider of DEMO_PROVIDER_OPTIONS) {
      for (const model of provider.models) {
        expect(gettingStarted).toContain(model.id);
        expect(modelDefaults).toContain(model.id);
      }
      const defaultModel = provider.models.find((model) => model.default);
      expect(defaultModel).toBeDefined();
    }

    for (const heartbeatModel of Object.values(HEARTBEAT_DEFAULTS)) {
      expect(modelDefaults).toContain(heartbeatModel);
    }
  });

  it('marks ambiguous salary-overlap scenarios for acceptable purpose negotiation', () => {
    const scenarios = readRepoFile('packages', 'selkey-demo-ui', 'public', 'scenarios.js');
    const appJs = readRepoFile('packages', 'selkey-demo-ui', 'public', 'app.js');

    expect(scenarios).toContain("id: 'sc06_salary_negotiation'");
    expect(scenarios).toContain("acceptablePurposes: ['MEDIATION', 'COMPATIBILITY']");
    expect(appJs).toContain('startBody.acceptablePurposes = runScenario.acceptablePurposes.slice();');
  });
});
