/**
 * Receipts this agent holds from its own completed relay sessions.
 *
 * Recorded by relay_signal when a session completes, from the local session
 * handle (the counterparty comes from local state, not from the receipt).
 * IFC grant issuance requires a held receipt whose counterparty is the grant
 * audience.
 *
 * File: $SELKEY_WORKDIR/.selkey/held-receipts.json (0600 in a 0700 directory).
 */

import * as path from 'node:path';

import { readPrivateJson, selkeyStateDir, writePrivateJson } from './secure-fs.js';

export interface HeldReceipt {
  agent_id: string;
  receipt_id: string;
  session_id: string;
  counterparty: string;
  role: 'INITIATOR' | 'RESPONDER';
  receipt_verified: boolean;
  recorded_at: string;
}

interface HeldReceiptsFileV1 {
  version: 1;
  receipts: HeldReceipt[];
}

const MAX_HELD_RECEIPTS = 1000;

export function heldReceiptsPath(stateDir: string = selkeyStateDir()): string {
  return path.join(stateDir, 'held-receipts.json');
}

function load(filePath: string): HeldReceiptsFileV1 {
  const raw = readPrivateJson(filePath) as Partial<HeldReceiptsFileV1> | undefined;
  if (raw === undefined) return { version: 1, receipts: [] };
  if (raw.version !== 1 || !Array.isArray(raw.receipts)) {
    throw new Error(`${filePath} is not a valid held-receipts file`);
  }
  return { version: 1, receipts: raw.receipts };
}

export function recordHeldReceipt(entry: HeldReceipt, stateDir?: string): void {
  const filePath = heldReceiptsPath(stateDir);
  const file = load(filePath);
  const rest = file.receipts.filter(
    (r) => !(r.agent_id === entry.agent_id && r.receipt_id === entry.receipt_id),
  );
  rest.push(entry);
  writePrivateJson(filePath, { version: 1, receipts: rest.slice(-MAX_HELD_RECEIPTS) });
}

export function findHeldReceipt(
  agentId: string,
  receiptId: string,
  stateDir?: string,
): HeldReceipt | undefined {
  return load(heldReceiptsPath(stateDir)).receipts.find(
    (r) => r.agent_id === agentId && r.receipt_id === receiptId,
  );
}
