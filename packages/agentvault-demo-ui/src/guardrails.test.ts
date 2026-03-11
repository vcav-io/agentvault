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

describe('demo guardrails', () => {
  it('builds agentvault-client before agentvault-mcp-server in run.sh', () => {
    const script = readRepoFile('packages', 'agentvault-demo-ui', 'run.sh');
    expect(script.indexOf('Building agentvault-client...')).toBeGreaterThan(-1);
    expect(script.indexOf('Building agentvault-mcp-server...')).toBeGreaterThan(-1);
    expect(script.indexOf('Building agentvault-client...')).toBeLessThan(
      script.indexOf('Building agentvault-mcp-server...'),
    );
  });

  it('builds contract milestone before relay policy in the start helper', () => {
    const helper = readRepoFile('packages', 'agentvault-demo-ui', 'src', 'start-milestones.ts');
    expect(helper).toContain("buildRelayContract('MEDIATION', ['alice', 'bob'], relayProfileId)");
    expect(helper.indexOf("agent: 'contract_enforcement'")).toBeLessThan(
      helper.indexOf("agent: 'relay_policy'"),
    );
  });

  it('keeps docs and UI strings aligned with current demo config', () => {
    const readme = readRepoFile('README.md');
    const gettingStarted = readRepoFile('docs', 'getting-started.md');
    const modelDefaults = readRepoFile('docs', 'model-defaults.md');
    const renderJs = readRepoFile('packages', 'agentvault-demo-ui', 'public', 'render.js');

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
});
