#!/usr/bin/env node

import { loadRegistryIndex, buildContract } from './contract-builder.js';
import type { ContractOptions } from './contract-builder.js';

function printUsage(): void {
  console.error(`Usage: av-contract build \\
  --registry <path> \\
  --schema <ref> \\
  --policy <ref> \\
  --profile <ref> \\
  --program <ref> \\
  --purpose <code> \\
  --participants <a,b,...> \\
  [--entropy-budget-bits <N>] \\
  [--entropy-enforcement Gate|Advisory] \\
  [--allow-deprecated]`);
}

function parseArgs(argv: string[]): {
  subcommand: string;
  flags: Map<string, string>;
  boolFlags: Set<string>;
} {
  const subcommand = argv[0] ?? '';
  const flags = new Map<string, string>();
  const boolFlags = new Set<string>();

  let i = 1;
  while (i < argv.length) {
    const arg = argv[i];
    if (arg === '--allow-deprecated') {
      boolFlags.add('allow-deprecated');
      i++;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        console.error(`Missing value for --${key}`);
        process.exit(1);
      }
      flags.set(key, value);
      i += 2;
    } else {
      console.error(`Unexpected argument: ${arg}`);
      process.exit(1);
    }
  }

  return { subcommand, flags, boolFlags };
}

function requireFlag(flags: Map<string, string>, name: string): string {
  const value = flags.get(name);
  if (value === undefined) {
    console.error(`Missing required flag: --${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length === 0) {
    printUsage();
    process.exit(1);
  }

  const { subcommand, flags, boolFlags } = parseArgs(args);

  if (subcommand !== 'build') {
    console.error(`Unknown subcommand: ${subcommand}`);
    printUsage();
    process.exit(1);
  }

  const registryPath = requireFlag(flags, 'registry');
  const schema = requireFlag(flags, 'schema');
  const policy = requireFlag(flags, 'policy');
  const profile = requireFlag(flags, 'profile');
  const program = requireFlag(flags, 'program');
  const purpose = requireFlag(flags, 'purpose');
  const participantsRaw = requireFlag(flags, 'participants');

  const participants = participantsRaw.split(',').filter((p) => p.length > 0);
  if (participants.length !== 2) {
    console.error('--participants must contain exactly 2 participants (bilateral only)');
    process.exit(1);
  }

  const options: ContractOptions = {
    schema,
    policy,
    profile,
    program,
    purpose_code: purpose,
    participants,
    allowDeprecated: boolFlags.has('allow-deprecated'),
  };

  const budgetBits = flags.get('entropy-budget-bits');
  if (budgetBits !== undefined) {
    const parsed = parseInt(budgetBits, 10);
    if (isNaN(parsed)) {
      console.error(`--entropy-budget-bits must be an integer, got: ${budgetBits}`);
      process.exit(1);
    }
    options.entropy_budget_bits = parsed;
  }

  const enforcement = flags.get('entropy-enforcement');
  if (enforcement !== undefined) {
    if (enforcement !== 'Gate' && enforcement !== 'Advisory') {
      console.error(`--entropy-enforcement must be Gate or Advisory, got: ${enforcement}`);
      process.exit(1);
    }
    options.entropy_enforcement = enforcement;
  }

  const registry = await loadRegistryIndex(registryPath);
  const contract = buildContract(registry, options);
  console.log(JSON.stringify(contract, null, 2));
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${message}`);
  process.exit(1);
});
