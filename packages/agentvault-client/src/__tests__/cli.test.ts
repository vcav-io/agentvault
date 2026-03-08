import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Helpers: create a temp registry with test artefacts
// ---------------------------------------------------------------------------

const schemaDigest = 'sha256:' + '0d25ea01'.padEnd(64, '0');
const policyDigest = 'sha256:' + 'b977379e'.padEnd(64, '0');
const profileDigest = 'sha256:' + '0892ed75'.padEnd(64, '0');
const programDigest = 'sha256:' + 'bc4fdec5'.padEnd(64, '0');

function makeEntry(id: string, description: string) {
  return {
    id,
    version: '1.0.0',
    description,
    status: 'active',
    published_at: '2026-03-07',
    compatibility: { safety_class: 'SAFE' },
  };
}

async function createTestRegistry(dir: string): Promise<void> {
  await writeFile(
    join(dir, 'registry.json'),
    JSON.stringify({
      registry_version: '1.0.0',
      kinds: ['schema', 'policy', 'profile', 'program'],
      indexes: {
        schema: 'schema/index.json',
        policy: 'policy/index.json',
        profile: 'profile/index.json',
        program: 'program/index.json',
      },
    }),
  );

  for (const [kind, digest, id, desc] of [
    ['schema', schemaDigest, 'vcav_e_mediation_signal_v2', 'Mediation signal schema'],
    ['policy', policyDigest, 'compatibility_safe_v1', 'Default safe policy'],
    ['profile', profileDigest, 'api-claude-sonnet-v1', 'Claude Sonnet profile'],
    ['program', programDigest, 'mediation_system_v1', 'Mediation prompt program'],
  ] as const) {
    await mkdir(join(dir, kind), { recursive: true });
    await writeFile(
      join(dir, kind, 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        kind,
        artefacts: { [digest]: makeEntry(id, desc) },
        aliases: { [id]: digest },
        channels: {},
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Run CLI as child process
// ---------------------------------------------------------------------------

const CLI_PATH = join(import.meta.dirname, '..', '..', 'dist', 'cli.js');

function runCli(args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((resolve) => {
    execFile('node', [CLI_PATH, ...args], (error, stdout, stderr) => {
      resolve({
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        code: error ? (error as { status?: number }).status ?? 1 : 0,
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'av-contract-test-'));
  await createTestRegistry(tmpDir);
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe('av-contract CLI', () => {
  it('builds a valid contract and outputs JSON to stdout', async () => {
    const result = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      '--policy', 'compatibility_safe_v1',
      '--profile', 'api-claude-sonnet-v1',
      '--program', 'mediation_system_v1',
      '--purpose', 'MEDIATION',
      '--participants', 'alice,bob',
      '--entropy-budget-bits', '12',
      '--entropy-enforcement', 'Advisory',
    ]);

    expect(result.code).toBe(0);
    const contract = JSON.parse(result.stdout);
    expect(contract.purpose_code).toBe('MEDIATION');
    expect(contract.output_schema_id).toBe('vcav_e_mediation_signal_v2');
    expect(contract.participants).toEqual(['alice', 'bob']);
    expect(contract.model_profile_id).toBe('api-claude-sonnet-v1');
    expect(contract.entropy_budget_bits).toBe(12);
    expect(contract.entropy_enforcement).toBe('Advisory');
    expect(contract.contract_hash).toMatch(/^[0-9a-f]{64}$/);
    // Warnings go to stderr, not stdout
    expect(result.stdout).not.toContain('WARNING');
  });

  it('exits with error for missing required flag', async () => {
    const { code, stderr } = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      // missing --policy and others
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain('Missing required flag');
  });

  it('exits with error for non-bilateral participant lists', async () => {
    const result = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      '--policy', 'compatibility_safe_v1',
      '--profile', 'api-claude-sonnet-v1',
      '--program', 'mediation_system_v1',
      '--purpose', 'MEDIATION',
      '--participants', 'alice',
    ]);

    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('exactly two participants');
  });

  it('exits with error for unknown subcommand', async () => {
    const { code, stderr } = await runCli(['deploy']);

    expect(code).not.toBe(0);
    expect(stderr).toContain('Unknown subcommand');
  });

  it('exits with error when no arguments provided', async () => {
    const { code, stderr } = await runCli([]);

    expect(code).not.toBe(0);
    expect(stderr).toContain('Usage');
  });

  it('passes --allow-deprecated flag', async () => {
    // Modify schema to be deprecated
    await writeFile(
      join(tmpDir, 'schema', 'index.json'),
      JSON.stringify({
        version: '1.0.0',
        kind: 'schema',
        artefacts: {
          [schemaDigest]: {
            ...makeEntry('vcav_e_mediation_signal_v2', 'Mediation signal schema'),
            status: 'deprecated',
          },
        },
        aliases: { 'vcav_e_mediation_signal_v2': schemaDigest },
        channels: {},
      }),
    );

    // Without --allow-deprecated should fail
    const fail = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      '--policy', 'compatibility_safe_v1',
      '--profile', 'api-claude-sonnet-v1',
      '--program', 'mediation_system_v1',
      '--purpose', 'MEDIATION',
      '--participants', 'alice,bob',
    ]);
    expect(fail.code).not.toBe(0);
    expect(fail.stderr).toContain('deprecated');

    // With --allow-deprecated should succeed
    const pass = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      '--policy', 'compatibility_safe_v1',
      '--profile', 'api-claude-sonnet-v1',
      '--program', 'mediation_system_v1',
      '--purpose', 'MEDIATION',
      '--participants', 'alice,bob',
      '--allow-deprecated',
    ]);
    expect(pass.code).toBe(0);
    const contract = JSON.parse(pass.stdout);
    expect(contract.purpose_code).toBe('MEDIATION');
  });

  it('rejects invalid --entropy-enforcement value', async () => {
    const { code, stderr } = await runCli([
      'build',
      '--registry', tmpDir,
      '--schema', 'vcav_e_mediation_signal_v2',
      '--policy', 'compatibility_safe_v1',
      '--profile', 'api-claude-sonnet-v1',
      '--program', 'mediation_system_v1',
      '--purpose', 'MEDIATION',
      '--participants', 'alice,bob',
      '--entropy-enforcement', 'Invalid',
    ]);

    expect(code).not.toBe(0);
    expect(stderr).toContain('Gate or Advisory');
  });
});
