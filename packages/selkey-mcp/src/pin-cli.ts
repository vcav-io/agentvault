/**
 * `selkey-mcp pins ...` — operator commands for agent identity pins.
 *
 *   selkey-mcp pins list
 *   selkey-mcp pins add <agent_id> <public_key_hex> [--alias <alias>]...
 *   selkey-mcp pins remove <agent_id>
 *   selkey-mcp pins confirm <agent_id>
 *   selkey-mcp pins rotate <statement.json> <new_public_key_hex>
 *
 * `confirm` accepts a first-contact (TOFU) key. It must run in an interactive
 * terminal and asks the person to type the fingerprint they obtained from the
 * counterparty out of band; it is never exposed as an MCP tool.
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline/promises';

import { PinStore, type KeyRotationStatement } from './pin-store.js';

export interface PinsCliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  isInteractive: boolean;
  prompt: (question: string) => Promise<string>;
}

const USAGE = [
  'Usage:',
  '  selkey-mcp pins list',
  '  selkey-mcp pins add <agent_id> <public_key_hex> [--alias <alias>]...',
  '  selkey-mcp pins remove <agent_id>',
  '  selkey-mcp pins confirm <agent_id>',
  '  selkey-mcp pins rotate <statement.json> <new_public_key_hex>',
].join('\n');

export async function runPinsCli(args: string[], store: PinStore, io: PinsCliIo): Promise<number> {
  const [command, ...rest] = args;
  try {
    switch (command) {
      case 'list': {
        for (const pin of store.listPins()) {
          const aliases = pin.aliases.length ? ` aliases=${pin.aliases.join(',')}` : '';
          io.out(`${pin.agent_id}  ${pin.fingerprint}  source=${pin.source}${aliases}`);
        }
        for (const p of store.listPending()) {
          io.out(`${p.agent_id}  ${p.fingerprint}  PENDING (first seen ${p.first_seen_at})`);
        }
        return 0;
      }
      case 'add': {
        const [agentId, keyHex, ...flags] = rest;
        if (!agentId || !keyHex) break;
        const aliases: string[] = [];
        for (let i = 0; i < flags.length; i++) {
          if (flags[i] === '--alias' && flags[i + 1]) aliases.push(flags[++i]);
          else {
            io.err(`Unknown option: ${flags[i]}`);
            return 2;
          }
        }
        const previous = store.getPin(agentId);
        const pin = store.setPin(agentId, keyHex, { aliases, source: 'cli' });
        if (previous && previous.public_key_hex !== pin.public_key_hex) {
          io.out(`Re-pinned ${pin.agent_id}: ${previous.fingerprint} -> ${pin.fingerprint}`);
        } else {
          io.out(`Pinned ${pin.agent_id}: ${pin.fingerprint}`);
        }
        return 0;
      }
      case 'remove': {
        const [agentId] = rest;
        if (!agentId) break;
        io.out(store.removePin(agentId) ? `Removed ${agentId}` : `No pin for ${agentId}`);
        return 0;
      }
      case 'confirm': {
        const [agentId] = rest;
        if (!agentId) break;
        const pending = store.listPending().find((p) => p.agent_id === agentId.normalize('NFC'));
        if (!pending) {
          io.err(`No pending first-contact key for ${agentId}.`);
          return 1;
        }
        if (!io.isInteractive) {
          io.err('pins confirm must be run by a person in an interactive terminal.');
          return 1;
        }
        io.out(`Agent ${pending.agent_id} presented key fingerprint:`);
        io.out(`  ${pending.fingerprint}`);
        io.out('Ask the counterparty for their fingerprint over a channel you trust.');
        const typed = await io.prompt('Type the fingerprint they gave you: ');
        const pin = store.confirmPending(agentId, typed);
        io.out(`Pinned ${pin.agent_id}: ${pin.fingerprint}`);
        return 0;
      }
      case 'rotate': {
        const [statementPath, newKeyHex] = rest;
        if (!statementPath || !newKeyHex) break;
        const statement = JSON.parse(fs.readFileSync(statementPath, 'utf8')) as KeyRotationStatement;
        const previous = store.getPin(statement.agent_id);
        const pin = store.applyRotation(statement, newKeyHex);
        io.out(`Rotated ${pin.agent_id}: ${previous?.fingerprint ?? '?'} -> ${pin.fingerprint}`);
        return 0;
      }
      default:
        break;
    }
  } catch (err) {
    io.err(err instanceof Error ? err.message : String(err));
    return 1;
  }
  io.err(USAGE);
  return 2;
}

export function processPinsCliIo(): PinsCliIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
    isInteractive: process.stdin.isTTY === true && process.stdout.isTTY === true,
    prompt: async (question) => {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        return await rl.question(question);
      } finally {
        rl.close();
      }
    },
  };
}
