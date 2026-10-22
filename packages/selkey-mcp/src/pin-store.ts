/**
 * Agent identity pins.
 *
 * One store maps an agent_id to the Ed25519 public key this agent accepts
 * signatures from. Every AFAL (PROPOSE/ADMIT/DENY/COMMIT), negotiation and IFC
 * signature from a peer is verified against `pins[agent_id]`, never against a
 * key carried in the peer's own message, card or descriptor.
 *
 * Storage: $SELKEY_WORKDIR/.selkey/pins.json (directory 0700, file 0600,
 * atomic O_EXCL writes). Loading refuses a group- or world-writable file.
 * Seeds: SELKEY_AFAL_TRUSTED_AGENTS and SELKEY_KNOWN_AGENTS (public_key_hex).
 *
 * Lookup is by exact NFC-normalised agent_id. Aliases resolve to an agent_id
 * (never to a key), match exactly (no case folding), and an alias that names
 * more than one agent is an error.
 *
 * Modes:
 * - `preshared` (default): an unpinned peer is rejected.
 * - `tofu`: the first key seen for an unpinned peer is recorded as pending and
 *   the operation fails with NEEDS_CONFIRMATION. A human confirms the
 *   fingerprint with the `selkey-mcp pins confirm` CLI; no MCP tool can.
 *
 * A key that differs from the pin always fails (KEY_CHANGED). The new key is
 * accepted only by an explicit re-pin, or by a rotation statement signed by
 * the pinned key (VCAV-KEY-ROTATION-V1).
 */

import * as path from 'node:path';
import { ed25519 } from '@noble/curves/ed25519';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

import { DOMAIN_PREFIXES, verifyMessage } from './afal-signing.js';
import { readPrivateJson, selkeyStateDir, writePrivateJson } from './secure-fs.js';

export type PinMode = 'preshared' | 'tofu';
export type PinSource = 'config' | 'cli' | 'tofu-confirmed' | 'rotation';

export type PinErrorCode =
  | 'UNPINNED'
  | 'NEEDS_CONFIRMATION'
  | 'KEY_CHANGED'
  | 'AMBIGUOUS_ALIAS'
  | 'INVALID_KEY'
  | 'INVALID_ROTATION';

export class PinError extends Error {
  readonly code: PinErrorCode;
  readonly agentId?: string;
  readonly pinnedFingerprint?: string;
  readonly presentedFingerprint?: string;

  constructor(
    code: PinErrorCode,
    message: string,
    details: { agentId?: string; pinnedFingerprint?: string; presentedFingerprint?: string } = {},
  ) {
    super(message);
    this.name = 'PinError';
    this.code = code;
    this.agentId = details.agentId;
    this.pinnedFingerprint = details.pinnedFingerprint;
    this.presentedFingerprint = details.presentedFingerprint;
  }
}

export interface AgentPin {
  agent_id: string;
  public_key_hex: string;
  fingerprint: string;
  aliases: string[];
  source: PinSource;
  pinned_at: string;
}

export interface PendingPin {
  agent_id: string;
  public_key_hex: string;
  fingerprint: string;
  first_seen_at: string;
}

export interface PinSeed {
  agentId: string;
  publicKeyHex?: string;
  aliases?: string[];
}

interface PinFileV1 {
  version: 1;
  pins: AgentPin[];
  pending: PendingPin[];
}

/** Minimal lookup interface used by verifiers. */
export interface PinResolver {
  /** Pinned key (lowercase hex) for an exact agent_id, or undefined. */
  pinnedKeyFor(agentId: string): string | undefined;
}

export interface KeyRotationStatement {
  agent_id: string;
  old_fpr: string;
  new_fpr: string;
  issued_at: string;
  signature: string;
}

const KEY_HEX_RE = /^[0-9a-f]{64}$/;
const ROTATION_MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function normalizeAgentId(agentId: string): string {
  return agentId.normalize('NFC');
}

/**
 * Validate and normalise an Ed25519 public key: 64 hex chars (case is
 * normalised to lowercase) that decode to a valid curve point.
 */
export function normalizePublicKeyHex(keyHex: string): string {
  const lower = typeof keyHex === 'string' ? keyHex.toLowerCase() : '';
  if (!KEY_HEX_RE.test(lower)) {
    throw new PinError('INVALID_KEY', 'public key must be 64 hex characters');
  }
  try {
    ed25519.ExtendedPoint.fromHex(lower);
  } catch {
    throw new PinError('INVALID_KEY', 'public key is not a valid Ed25519 point');
  }
  return lower;
}

/** Key fingerprint: "ed25519:" + hex(SHA-256(raw 32-byte public key)). */
export function keyFingerprint(publicKeyHex: string): string {
  return `ed25519:${bytesToHex(sha256(hexToBytes(publicKeyHex.toLowerCase())))}`;
}

/**
 * Resolve a user-supplied agent hint (an agent_id or alias) to an agent_id.
 * Exact NFC comparison only. Returns undefined when nothing matches, throws
 * AMBIGUOUS_ALIAS when the hint names more than one agent.
 */
export function resolveAgentHint(
  hint: string,
  agents: ReadonlyArray<{ agent_id: string; aliases?: readonly string[] }>,
): string | undefined {
  const wanted = normalizeAgentId(hint);
  const matches = new Set<string>();
  for (const agent of agents) {
    const id = normalizeAgentId(agent.agent_id);
    if (id === wanted || (agent.aliases ?? []).some((a) => normalizeAgentId(a) === wanted)) {
      matches.add(id);
    }
  }
  if (matches.size > 1) {
    throw new PinError(
      'AMBIGUOUS_ALIAS',
      `"${hint}" matches more than one agent (${[...matches].sort().join(', ')}); use the exact agent_id`,
    );
  }
  return matches.size === 1 ? [...matches][0] : undefined;
}

export function defaultPinFilePath(): string {
  return path.join(selkeyStateDir(), 'pins.json');
}

export function parsePinMode(value: string | undefined): PinMode {
  if (value === undefined || value === '' || value === 'preshared') return 'preshared';
  if (value === 'tofu') return 'tofu';
  throw new Error(`SELKEY_AGENT_PIN_MODE must be "preshared" or "tofu" (got "${value}")`);
}

export class PinStore implements PinResolver {
  readonly mode: PinMode;
  private readonly filePath: string | undefined;
  private readonly pins = new Map<string, AgentPin>();
  private readonly pending = new Map<string, PendingPin>();

  private constructor(mode: PinMode, filePath: string | undefined) {
    this.mode = mode;
    this.filePath = filePath;
  }

  /** An in-memory store (nothing is written to disk). */
  static inMemory(seeds: PinSeed[] = [], mode: PinMode = 'preshared'): PinStore {
    const store = new PinStore(mode, undefined);
    store.applySeeds(seeds);
    return store;
  }

  /**
   * Open the persistent store at `filePath`, merge `seeds`, and persist the
   * result if anything changed. Throws if the file is insecure or malformed.
   */
  static open(params: { filePath?: string; seeds?: PinSeed[]; mode?: PinMode } = {}): PinStore {
    const filePath = params.filePath ?? defaultPinFilePath();
    const store = new PinStore(params.mode ?? 'preshared', filePath);
    const raw = readPrivateJson(filePath);
    if (raw !== undefined) store.loadFile(raw, filePath);
    if (store.applySeeds(params.seeds ?? [])) store.persist();
    return store;
  }

  private loadFile(raw: unknown, filePath: string): void {
    const file = raw as Partial<PinFileV1> | null;
    if (!file || file.version !== 1 || !Array.isArray(file.pins) || !Array.isArray(file.pending)) {
      throw new Error(`${filePath} is not a valid pin store (version 1)`);
    }
    for (const pin of file.pins) {
      if (!pin || typeof pin.agent_id !== 'string' || typeof pin.public_key_hex !== 'string') {
        throw new Error(`${filePath} contains a malformed pin`);
      }
      const agentId = normalizeAgentId(pin.agent_id);
      const key = normalizePublicKeyHex(pin.public_key_hex);
      this.pins.set(agentId, {
        agent_id: agentId,
        public_key_hex: key,
        fingerprint: keyFingerprint(key),
        aliases: Array.isArray(pin.aliases)
          ? pin.aliases.filter((a): a is string => typeof a === 'string').map(normalizeAgentId)
          : [],
        source: pin.source ?? 'config',
        pinned_at: typeof pin.pinned_at === 'string' ? pin.pinned_at : new Date(0).toISOString(),
      });
    }
    for (const p of file.pending) {
      if (!p || typeof p.agent_id !== 'string' || typeof p.public_key_hex !== 'string') continue;
      const agentId = normalizeAgentId(p.agent_id);
      const key = normalizePublicKeyHex(p.public_key_hex);
      this.pending.set(agentId, {
        agent_id: agentId,
        public_key_hex: key,
        fingerprint: keyFingerprint(key),
        first_seen_at: typeof p.first_seen_at === 'string' ? p.first_seen_at : new Date(0).toISOString(),
      });
    }
  }

  /**
   * Apply configuration seeds. A seed is explicit operator configuration, so
   * it sets (or replaces) the pin for its agent_id. Returns true if anything
   * changed.
   */
  private applySeeds(seeds: PinSeed[]): boolean {
    let changed = false;
    for (const seed of seeds) {
      const agentId = normalizeAgentId(seed.agentId);
      const aliases = (seed.aliases ?? []).map(normalizeAgentId);
      const existing = this.pins.get(agentId);
      if (!seed.publicKeyHex) {
        // Alias-only seed: attach aliases to an existing pin.
        if (existing) {
          const merged = [...new Set([...existing.aliases, ...aliases])];
          if (merged.length !== existing.aliases.length) {
            existing.aliases = merged;
            changed = true;
          }
        }
        continue;
      }
      const key = normalizePublicKeyHex(seed.publicKeyHex);
      if (existing && existing.public_key_hex === key) {
        const merged = [...new Set([...existing.aliases, ...aliases])];
        if (merged.length !== existing.aliases.length) {
          existing.aliases = merged;
          changed = true;
        }
        continue;
      }
      if (existing) {
        console.warn(
          `[selkey pins] configured key for ${agentId} replaces the stored pin ` +
            `(${existing.fingerprint} -> ${keyFingerprint(key)})`,
        );
      }
      this.pins.set(agentId, {
        agent_id: agentId,
        public_key_hex: key,
        fingerprint: keyFingerprint(key),
        aliases: [...new Set([...(existing?.aliases ?? []), ...aliases])],
        source: 'config',
        pinned_at: new Date().toISOString(),
      });
      this.pending.delete(agentId);
      changed = true;
    }
    return changed;
  }

  private persist(): void {
    if (!this.filePath) return;
    const file: PinFileV1 = {
      version: 1,
      pins: [...this.pins.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
      pending: [...this.pending.values()].sort((a, b) => a.agent_id.localeCompare(b.agent_id)),
    };
    writePrivateJson(this.filePath, file);
  }

  get path(): string | undefined {
    return this.filePath;
  }

  listPins(): AgentPin[] {
    return [...this.pins.values()].map((p) => ({ ...p, aliases: [...p.aliases] }));
  }

  listPending(): PendingPin[] {
    return [...this.pending.values()].map((p) => ({ ...p }));
  }

  getPin(agentId: string): AgentPin | undefined {
    const pin = this.pins.get(normalizeAgentId(agentId));
    return pin ? { ...pin, aliases: [...pin.aliases] } : undefined;
  }

  private snapshot(id: string): AgentPin {
    const pin = this.getPin(id);
    if (!pin) throw new Error(`pin for ${id} disappeared`);
    return pin;
  }

  pinnedKeyFor(agentId: string): string | undefined {
    return this.pins.get(normalizeAgentId(agentId))?.public_key_hex;
  }

  /** Resolve an agent_id or alias to a pinned agent_id (exact match). */
  resolveAgentId(hint: string): string | undefined {
    return resolveAgentHint(hint, [...this.pins.values()]);
  }

  /** The pinned key for `agentId`, or throw UNPINNED. */
  requirePinnedKey(agentId: string): string {
    const key = this.pinnedKeyFor(agentId);
    if (!key) {
      throw new PinError(
        'UNPINNED',
        `No pinned key for agent "${agentId}". Pin it with \`selkey-mcp pins add <agent_id> <public_key_hex>\` ` +
          'or SELKEY_AFAL_TRUSTED_AGENTS / SELKEY_KNOWN_AGENTS, using a key obtained out of band.',
        { agentId },
      );
    }
    return key;
  }

  /**
   * Check a key a peer presented (card, descriptor) against the pin and return
   * the pinned key to verify signatures with.
   *
   * - pinned, same key: returns it.
   * - pinned, different key: KEY_CHANGED (both fingerprints in the error).
   * - unpinned, preshared mode: UNPINNED.
   * - unpinned, tofu mode: records the key as pending and throws
   *   NEEDS_CONFIRMATION with its fingerprint.
   */
  checkPresentedKey(agentId: string, presentedKeyHex: string): string {
    const id = normalizeAgentId(agentId);
    let presented: string;
    try {
      presented = normalizePublicKeyHex(presentedKeyHex);
    } catch {
      throw new PinError('INVALID_KEY', `Agent "${id}" presented a malformed public key`, { agentId: id });
    }
    const pinned = this.pins.get(id);
    if (pinned) {
      if (pinned.public_key_hex === presented) return pinned.public_key_hex;
      throw new PinError(
        'KEY_CHANGED',
        `Agent "${id}" presented a key that differs from its pin ` +
          `(pinned ${pinned.fingerprint}, presented ${keyFingerprint(presented)}). ` +
          'Re-pin only after confirming the new key with the agent out of band, ' +
          'or apply a rotation statement signed by the pinned key.',
        { agentId: id, pinnedFingerprint: pinned.fingerprint, presentedFingerprint: keyFingerprint(presented) },
      );
    }
    if (this.mode !== 'tofu') {
      return this.requirePinnedKey(id);
    }
    const fingerprint = keyFingerprint(presented);
    const existingPending = this.pending.get(id);
    if (!existingPending || existingPending.public_key_hex !== presented) {
      this.pending.set(id, {
        agent_id: id,
        public_key_hex: presented,
        fingerprint,
        first_seen_at: new Date().toISOString(),
      });
      this.persist();
    }
    throw new PinError(
      'NEEDS_CONFIRMATION',
      `First contact with agent "${id}" (key fingerprint ${fingerprint}). ` +
        'A person must compare this fingerprint with the agent out of band and confirm it ' +
        `in a terminal: \`selkey-mcp pins confirm ${id}\`. Then retry.`,
      { agentId: id, presentedFingerprint: fingerprint },
    );
  }

  /** Confirm a pending first-contact key. Only the CLI calls this. */
  confirmPending(agentId: string, fingerprint: string): AgentPin {
    const id = normalizeAgentId(agentId);
    const pending = this.pending.get(id);
    if (!pending) throw new PinError('UNPINNED', `No pending key for agent "${id}"`, { agentId: id });
    if (pending.fingerprint !== fingerprint.trim().toLowerCase()) {
      throw new PinError('KEY_CHANGED', `Fingerprint does not match the pending key for "${id}"`, {
        agentId: id,
        presentedFingerprint: pending.fingerprint,
      });
    }
    this.pins.set(id, {
      agent_id: id,
      public_key_hex: pending.public_key_hex,
      fingerprint: pending.fingerprint,
      aliases: this.pins.get(id)?.aliases ?? [],
      source: 'tofu-confirmed',
      pinned_at: new Date().toISOString(),
    });
    this.pending.delete(id);
    this.persist();
    return this.snapshot(id);
  }

  /** Explicitly pin (or re-pin) a key. Only configuration and the CLI call this. */
  setPin(agentId: string, publicKeyHex: string, opts: { aliases?: string[]; source?: PinSource } = {}): AgentPin {
    const id = normalizeAgentId(agentId);
    if (!id) throw new Error('agent_id must not be empty');
    const key = normalizePublicKeyHex(publicKeyHex);
    const existing = this.pins.get(id);
    this.pins.set(id, {
      agent_id: id,
      public_key_hex: key,
      fingerprint: keyFingerprint(key),
      aliases: [...new Set([...(existing?.aliases ?? []), ...(opts.aliases ?? []).map(normalizeAgentId)])],
      source: opts.source ?? 'cli',
      pinned_at: new Date().toISOString(),
    });
    this.pending.delete(id);
    this.persist();
    return this.snapshot(id);
  }

  removePin(agentId: string): boolean {
    const id = normalizeAgentId(agentId);
    const removed = this.pins.delete(id) || this.pending.delete(id);
    if (removed) this.persist();
    return removed;
  }

  /**
   * Apply a key rotation statement: signed under the CURRENT pinned key with
   * domain prefix VCAV-KEY-ROTATION-V1:, naming the pinned key's fingerprint
   * as old_fpr and the fingerprint of `newPublicKeyHex` as new_fpr.
   */
  applyRotation(statement: KeyRotationStatement, newPublicKeyHex: string, nowMs = Date.now()): AgentPin {
    verifyRotationShape(statement);
    const id = normalizeAgentId(statement.agent_id);
    const pinned = this.pins.get(id);
    if (!pinned) throw new PinError('UNPINNED', `No pinned key for agent "${id}"`, { agentId: id });
    const newKey = normalizePublicKeyHex(newPublicKeyHex);
    if (statement.old_fpr !== pinned.fingerprint) {
      throw new PinError('INVALID_ROTATION', 'rotation old_fpr does not match the pinned key', { agentId: id });
    }
    if (statement.new_fpr !== keyFingerprint(newKey)) {
      throw new PinError('INVALID_ROTATION', 'rotation new_fpr does not match the new key', { agentId: id });
    }
    const issuedMs = Date.parse(statement.issued_at);
    if (Number.isNaN(issuedMs) || issuedMs > nowMs + ROTATION_MAX_FUTURE_SKEW_MS) {
      throw new PinError('INVALID_ROTATION', 'rotation issued_at is invalid or in the future', { agentId: id });
    }
    if (
      !verifyMessage(
        DOMAIN_PREFIXES.KEY_ROTATION,
        statement as unknown as Record<string, unknown>,
        pinned.public_key_hex,
      )
    ) {
      throw new PinError('INVALID_ROTATION', 'rotation statement is not signed by the pinned key', { agentId: id });
    }
    this.pins.set(id, {
      ...pinned,
      public_key_hex: newKey,
      fingerprint: keyFingerprint(newKey),
      source: 'rotation',
      pinned_at: new Date(nowMs).toISOString(),
    });
    this.pending.delete(id);
    this.persist();
    return this.snapshot(id);
  }
}

function verifyRotationShape(statement: KeyRotationStatement): void {
  const s = statement as unknown as Record<string, unknown>;
  const allowed = new Set(['agent_id', 'old_fpr', 'new_fpr', 'issued_at', 'signature']);
  if (!s || typeof s !== 'object' || Object.keys(s).some((k) => !allowed.has(k))) {
    throw new PinError('INVALID_ROTATION', 'rotation statement has unexpected fields');
  }
  for (const field of allowed) {
    if (typeof s[field] !== 'string' || !s[field]) {
      throw new PinError('INVALID_ROTATION', `rotation statement is missing ${field}`);
    }
  }
}
