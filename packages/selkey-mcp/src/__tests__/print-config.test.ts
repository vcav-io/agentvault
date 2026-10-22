import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIST = path.resolve(__dirname, '../../dist/index.js');

describe('selkey-mcp --print-config', () => {
  it.skipIf(!fs.existsSync(DIST))('includes the relay key and operator token placeholders', () => {
    const out = execFileSync(process.execPath, [DIST, '--print-config'], {
      env: { ...process.env, SELKEY_ENV: 'dev' },
      encoding: 'utf8',
    });
    const env = JSON.parse(out.slice(out.indexOf('{'))).mcpServers.selkey.env as Record<string, string>;
    expect(env).toHaveProperty('SELKEY_RELAY_VERIFYING_KEY_HEX');
    expect(env).toHaveProperty('SELKEY_OPERATOR_TOKEN');
  });
});
