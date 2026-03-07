/**
 * AgentVault Demo UI — Express server.
 *
 * Serves the web UI, manages two persistent agent heartbeat loops
 * (Alice + Bob), provides SSE events, and records JSONL runs.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config as dotenvConfig } from 'dotenv';
import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex } from '@noble/hashes/utils';
import { randomBytes } from 'node:crypto';
import {
  verifyReceipt,
  fetchRelayPublicKey,
} from 'agentvault-client/verify';

import {
  createToolRegistry,
  type ToolRegistryConfig,
} from 'agentvault-mcp-server/tools';
import {
  DirectAfalTransport,
  isAgentDescriptor,
  AfalHttpServer,
} from 'agentvault-mcp-server';
import type {
  DirectAfalTransportConfig,
  AdmissionPolicy,
  TrustedAgent,
} from 'agentvault-mcp-server';
import { signMessage, DOMAIN_PREFIXES } from 'agentvault-mcp-server';
import {
  buildRelayContract,
  computeRelayContractHash,
  computeOutputSchemaHash,
} from 'agentvault-client/contracts';

import { EventBus } from './events.js';
import { replayToSSE, listRuns } from './replay.js';
import {
  runHeartbeatLoop,
  sendUserMessage,
  createQueue,
  type AgentState,
} from './agent-loop.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { GeminiProvider } from './providers/gemini.js';
import type { LLMProvider } from './providers/types.js';

// ── Constants ────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(__dirname, '../public');
const DEMO_DIR = path.resolve(__dirname, '..');

const PORT = parseInt(process.env['DEMO_PORT'] ?? '3200', 10);
const RELAY_URL = process.env['AV_RELAY_URL'] ?? 'http://localhost:3100';
const RUNS_DIR = process.env['DEMO_RUNS_DIR'] ?? path.join(DEMO_DIR, 'runs');
const BOB_AFAL_PORT = parseInt(process.env['BOB_AFAL_PORT'] ?? '3201', 10);
const ALICE_AFAL_PORT = parseInt(process.env['ALICE_AFAL_PORT'] ?? '3202', 10);

// ── Load .env ────────────────────────────────────────────────────────────

// Try loading from package dir, then from repo root
dotenvConfig({ path: path.join(DEMO_DIR, '.env') });
dotenvConfig({ path: path.resolve(DEMO_DIR, '../../.env') });

// ── Provider setup ───────────────────────────────────────────────────────

/** Detect which provider to use: explicit PROVIDER env, or auto-detect from API keys. */
function detectProvider(): 'anthropic' | 'openai' | 'gemini' {
  const explicit = process.env['PROVIDER']?.toLowerCase();
  if (explicit === 'openai' || explicit === 'anthropic' || explicit === 'gemini') return explicit;

  // Auto-detection: cheapest first (Gemini > OpenAI > Anthropic)
  if (process.env['GEMINI_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected Gemini from API key. Set PROVIDER=gemini to suppress this warning.');
    return 'gemini';
  }
  if (process.env['OPENAI_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected OpenAI from API key. Set PROVIDER=openai to suppress this warning.');
    return 'openai';
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected Anthropic from API key. Set PROVIDER=anthropic to suppress this warning.');
    return 'anthropic';
  }

  throw new Error(
    'No LLM provider configured. Set PROVIDER=gemini|openai|anthropic and the matching API key in .env',
  );
}

/** Create a provider from explicit provider name and optional model. */
function createProviderFromSpec(providerName: string, model?: string): LLMProvider {
  if (providerName === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when provider=gemini');
    console.log(`Using Gemini provider, model: ${model ?? 'gemini-2.5-flash (default)'}`);
    return new GeminiProvider(apiKey, model);
  }

  if (providerName === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when provider=openai');
    console.log(`Using OpenAI provider, model: ${model ?? 'gpt-4.1-mini (default)'}`);
    return new OpenAIProvider(apiKey, model);
  }

  if (providerName === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when provider=anthropic');
    console.log(`Using Anthropic provider, model: ${model ?? 'claude-haiku-4-5-20251001 (default)'}`);
    return new AnthropicProvider(apiKey, model);
  }

  throw new Error(`Unknown provider: ${providerName}. Must be gemini, openai, or anthropic.`);
}

function createProvider(): LLMProvider {
  const provider = detectProvider();
  const model = process.env['MODEL'];
  return createProviderFromSpec(provider, model);
}

/** Default heartbeat models per provider — cheapest with tool use support. */
const HEARTBEAT_DEFAULTS: Record<string, string> = {
  gemini: 'gemini-2.5-flash-lite',
  openai: 'gpt-4.1-nano',
  anthropic: 'claude-haiku-4-5-20251001',
};

function createHeartbeatProvider(): LLMProvider {
  const provider = detectProvider();
  // Explicit guard: HEARTBEAT_DEFAULTS covers all provider values returned by
  // detectProvider(), but if that contract ever breaks we want a clear error.
  const defaultModel = HEARTBEAT_DEFAULTS[provider];
  if (!defaultModel) throw new Error(`No default heartbeat model defined for provider: ${provider}`);
  const model = process.env['HEARTBEAT_MODEL'] ?? defaultModel;
  if (!process.env['HEARTBEAT_MODEL']) {
    console.log(`Using ${provider} heartbeat provider, model: ${model} (default — set HEARTBEAT_MODEL to override)`);
  } else {
    console.log(`Using ${provider} heartbeat provider, model: ${model}`);
  }

  if (provider === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when PROVIDER=gemini');
    return new GeminiProvider(apiKey, model);
  }

  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when PROVIDER=openai');
    return new OpenAIProvider(apiKey, model);
  }

  // Anthropic (default fallback — detectProvider() already validated the key exists)
  const apiKey = process.env['ANTHROPIC_API_KEY'];
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when PROVIDER=anthropic');
  return new AnthropicProvider(apiKey, model);
}

// ── Ed25519 identity helpers ─────────────────────────────────────────────

function generateIdentity(): { seedHex: string; pubKeyHex: string } {
  const seed = randomBytes(32);
  const seedHex = seed.toString('hex');
  const pubKeyHex = bytesToHex(ed25519.getPublicKey(seed));
  return { seedHex, pubKeyHex };
}

function buildDescriptor(agentId: string, seedHex: string, pubKeyHex: string, httpPort?: number) {
  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
  const base = httpPort ? `http://127.0.0.1:${httpPort}` : '';

  const descriptorUnsigned: Record<string, unknown> = {
    descriptor_version: '1',
    agent_id: agentId,
    issued_at: now,
    expires_at: expiresAt,
    identity_key: { algorithm: 'ed25519', public_key_hex: pubKeyHex },
    envelope_key: { algorithm: 'ed25519', public_key_hex: pubKeyHex },
    endpoints: {
      propose: base ? `${base}/afal/propose` : '',
      commit: base ? `${base}/afal/commit` : '',
    },
    capabilities: { supported_body_formats: ['wrapped_v1'], supports_commit: true },
    policy_commitments: {},
  };

  const signed = signMessage(DOMAIN_PREFIXES.DESCRIPTOR, descriptorUnsigned, seedHex);
  if (!isAgentDescriptor(signed)) {
    throw new Error('signMessage produced invalid AgentDescriptor');
  }
  return signed;
}

// ── Prompts ──────────────────────────────────────────────────────────────

function loadPrompt(name: string): string {
  const promptPath = path.resolve(DEMO_DIR, `../../demo/${name}-prompt.md`);
  if (fs.existsSync(promptPath)) return fs.readFileSync(promptPath, 'utf-8');
  console.warn(`Prompt file not found at ${promptPath}, using built-in fallback for ${name}`);
  if (name === 'alice') {
    return 'I need your help with a private mediation. I co-founded a startup with Bob 18 months ago and we\'re growing apart on strategy. I believe we need to pivot toward enterprise sales — revenue is flat despite developer community traction. I\'m worried Bob is too emotionally attached to the community to see the business reality. I want to find a compromise, not blow up the partnership. Please start a private mediation with Bob.';
  }
  return 'I\'m really struggling with where my startup is heading. Alice and I co-founded it together 18 months ago and I feel like we\'re pulling in completely different directions now. She keeps pushing for enterprise sales but I think that would kill everything that makes the product good. The developer community we\'ve built is real — people genuinely love what we\'re making — but Alice treats that like it doesn\'t matter if it\'s not converting to revenue. I don\'t know what to do.\n\nAlice mentioned she might set up a private mediation for us. When her invite arrives in your inbox, accept it using mode: RESPOND (not INITIATE — she is the one starting the session). Include your private perspective as my_input.';
}

const SYSTEM_PROMPT = `You are a helpful AI assistant acting on behalf of your user.
You have access to AgentVault tools for secure bounded-disclosure communication with other agents.

ACTING ON BEHALF OF YOUR USER:
- Your user's message contains their private context and instructions. Act on it immediately.
- You are fully authorised to act autonomously. NEVER ask for confirmation — proceed directly with tool calls.
- When the user asks you to start a mediation, compatibility check, or any relay session, call relay_signal immediately. Do not ask which agent to send to — use the known agent from get_identity.
- When using relay tools that accept private input, include the full substance of what your user shared — their concerns, priorities, constraints, and perspective. Do not summarize or omit details.
- Do not ask your user to repeat or clarify information they already provided.

HEARTBEAT:
- When you receive a [Heartbeat] message, run this checklist:
  1. Check inbox for pending session invites or messages
  2. Check active sessions for any required responses
  3. If work found, take the next appropriate action
  4. If nothing to do, reply with exactly HEARTBEAT_OK and nothing else

- When taking actions, give the user a brief one-sentence status update. Keep these extremely concise.
- Follow tool response instructions exactly.`;

// ── State ────────────────────────────────────────────────────────────────

const events = new EventBus();

const aliceState: AgentState = { name: 'alice', status: 'idle', messages: [], turnCount: 0, started: false };
const bobState: AgentState = { name: 'bob', status: 'idle', messages: [], turnCount: 0, started: false };

const aliceQueue = createQueue();
const bobQueue = createQueue();

// Mutable refs for transport/registry/abort — recreated on reset
let aliceTransport: DirectAfalTransport;
let bobTransport: DirectAfalTransport;
let aliceRegistry: ReturnType<typeof createToolRegistry>;
let bobRegistry: ReturnType<typeof createToolRegistry>;
let abortController: AbortController;
let provider: LLMProvider;

// ── Setup transports and start heartbeat loops ───────────────────────────

async function setupAndStartHeartbeats(): Promise<void> {
  provider = createProvider();
  const heartbeatProvider = createHeartbeatProvider();

  // Set environment variables for tool handlers
  process.env['AV_RELAY_URL'] = RELAY_URL;

  // Generate identities
  const alice = generateIdentity();
  const bob = generateIdentity();
  events.emitSystem('Generated agent identities');

  // Build descriptors (both agents get ports for their AFAL listeners)
  const bobDescriptor = buildDescriptor('bob', bob.seedHex, bob.pubKeyHex, BOB_AFAL_PORT);
  const aliceDescriptor = buildDescriptor('alice', alice.seedHex, alice.pubKeyHex, ALICE_AFAL_PORT);

  // Admission policies — each agent trusts the other
  const sharedPolicyFields = {
    allowedPurposeCodes: ['MEDIATION', 'COMPATIBILITY'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY' as const,
  };
  const bobPolicy: AdmissionPolicy = {
    trustedAgents: [{ agentId: 'alice', publicKeyHex: alice.pubKeyHex }] as TrustedAgent[],
    ...sharedPolicyFields,
  };
  const alicePolicy: AdmissionPolicy = {
    trustedAgents: [{ agentId: 'bob', publicKeyHex: bob.pubKeyHex }] as TrustedAgent[],
    ...sharedPolicyFields,
  };

  // Symmetric transport configs — both can initiate AND respond
  const bobTransportConfig: DirectAfalTransportConfig = {
    agentId: 'bob',
    seedHex: bob.seedHex,
    localDescriptor: bobDescriptor,
    peerDescriptorUrl: `http://127.0.0.1:${ALICE_AFAL_PORT}/afal/descriptor`,
    respondMode: { httpPort: BOB_AFAL_PORT, bindAddress: '127.0.0.1', policy: bobPolicy },
  };
  const aliceTransportConfig: DirectAfalTransportConfig = {
    agentId: 'alice',
    seedHex: alice.seedHex,
    localDescriptor: aliceDescriptor,
    peerDescriptorUrl: `http://127.0.0.1:${BOB_AFAL_PORT}/afal/descriptor`,
    respondMode: { httpPort: ALICE_AFAL_PORT, bindAddress: '127.0.0.1', policy: alicePolicy },
  };

  // Start both AFAL HTTP listeners before any transport use
  bobTransport = new DirectAfalTransport(bobTransportConfig);
  aliceTransport = new DirectAfalTransport(aliceTransportConfig);
  await bobTransport.start();
  events.emitSystem(`Bob AFAL listening on port ${BOB_AFAL_PORT}`);
  await aliceTransport.start();
  events.emitSystem(`Alice AFAL listening on port ${ALICE_AFAL_PORT}`);

  // Create tool registries
  const aliceKnownAgents = [{ agent_id: 'bob', aliases: ['Bob'] }];
  const bobKnownAgents = [{ agent_id: 'alice', aliases: ['Alice'] }];

  aliceRegistry = createToolRegistry({
    transport: aliceTransport,
    knownAgents: aliceKnownAgents,
  });

  bobRegistry = createToolRegistry({
    transport: bobTransport,
    knownAgents: bobKnownAgents,
  });

  // Start heartbeat loops (never resolve — killed by AbortSignal)
  abortController = new AbortController();

  const aliceParams = {
    name: 'alice',
    provider,
    registry: aliceRegistry,
    systemPrompt: SYSTEM_PROMPT,
    events,
    state: aliceState,
    queue: aliceQueue,
    heartbeatProvider,
  };

  const bobParams = {
    name: 'bob',
    provider,
    registry: bobRegistry,
    systemPrompt: SYSTEM_PROMPT,
    events,
    state: bobState,
    queue: bobQueue,
    heartbeatProvider,
  };

  // Fire and forget — these loops never resolve
  runHeartbeatLoop(aliceParams, abortController.signal).catch((err) => {
    console.error('Alice heartbeat loop error:', err);
    events.emitSystem(`Alice heartbeat error: ${err instanceof Error ? err.message : 'Unknown'}`);
  });
  runHeartbeatLoop(bobParams, abortController.signal).catch((err) => {
    console.error('Bob heartbeat loop error:', err);
    events.emitSystem(`Bob heartbeat error: ${err instanceof Error ? err.message : 'Unknown'}`);
  });

  events.emitSystem('Heartbeat loops started');
}

// ── Express app ──────────────────────────────────────────────────────────

const app = express();
app.use(express.json());
app.use(express.static(PUBLIC_DIR));

// Config endpoint — available providers and models for UI selectors
app.get('/api/config', (_req, res) => {
  const providers: Array<{ name: string; models: Array<{ id: string; tier: string; default?: boolean }> }> = [];
  if (process.env['GEMINI_API_KEY']) {
    providers.push({
      name: 'gemini',
      models: [
        { id: 'gemini-2.5-flash', tier: 'mid', default: true },
        { id: 'gemini-2.5-flash-lite', tier: 'budget' },
      ],
    });
  }
  if (process.env['OPENAI_API_KEY']) {
    providers.push({
      name: 'openai',
      models: [
        { id: 'gpt-4.1-mini', tier: 'mid', default: true },
        { id: 'gpt-4.1-nano', tier: 'budget' },
      ],
    });
  }
  if (process.env['ANTHROPIC_API_KEY']) {
    providers.push({
      name: 'anthropic',
      models: [
        { id: 'claude-haiku-4-5-20251001', tier: 'budget', default: true },
        { id: 'claude-sonnet-4-6', tier: 'reference' },
      ],
    });
  }
  let defaultProvider: string | null = null;
  try { defaultProvider = detectProvider(); } catch { /* no keys configured */ }
  res.json({ providers, defaultProvider });
});

// SSE events endpoint
app.get('/api/events', (_req, res) => {
  events.addClient(res);
});

// Status endpoint
app.get('/api/status', (_req, res) => {
  res.json({
    started: aliceState.started || bobState.started,
    alice: { status: aliceState.status, turnCount: aliceState.turnCount },
    bob: { status: bobState.status, turnCount: bobState.turnCount },
    sseClients: events.clientCount,
    runFile: events.getRunFile(),
  });
});

// Start demo — sends initial user messages only (transports already running)
app.post('/api/start', async (req, res) => {
  if (aliceState.started || bobState.started) {
    res.status(409).json({ error: 'Demo already running' });
    return;
  }

  try {
    // Per-run provider override: if agentProvider is specified, switch the
    // module-level provider for this run (persists until next /api/start or reset).
    // Note: heartbeat loops keep their startup provider — they're lightweight polling
    // loops and restarting them mid-session would risk losing in-flight state.
    const agentProvider = req.body?.agentProvider as string | undefined;
    const agentModel = req.body?.agentModel as string | undefined;
    if (agentProvider) {
      provider = createProviderFromSpec(agentProvider, agentModel);
      events.emitSystem(`Agent provider overridden: ${agentProvider}/${agentModel ?? 'default'}`);
    }

    // Start JSONL recording
    const runFile = events.startRecording(RUNS_DIR);
    events.emitSystem(`Recording to ${runFile}`);

    // Emit contract parameters first — the contract drives the session and
    // specifies which enforcement policy to use (by hash).
    let relayHealth: Record<string, unknown> | null = null;
    try {
      const mediationContract = buildRelayContract('MEDIATION', ['alice', 'bob']);
      if (mediationContract) {
        const schemaHash = computeOutputSchemaHash(mediationContract.output_schema);
        events.emit({
          ts: new Date().toISOString(),
          type: 'system',
          agent: 'contract_enforcement',
          payload: {
            purpose_code: mediationContract.purpose_code,
            output_schema_id: mediationContract.output_schema_id,
            output_schema_hash: schemaHash,
            enforcement_policy_hash: mediationContract.enforcement_policy_hash ?? null,
            entropy_enforcement: mediationContract.entropy_enforcement ?? 'Advisory',
            entropy_budget_bits: mediationContract.entropy_budget_bits,
            max_completion_tokens: mediationContract.max_completion_tokens ?? null,
            model_constraints: mediationContract.model_constraints ?? null,
            session_ttl_secs: mediationContract.session_ttl_secs ?? null,
            invite_ttl_secs: mediationContract.invite_ttl_secs ?? null,
            model_profile_id: mediationContract.model_profile_id,
          },
        });
      }
    } catch (err) {
      console.warn('Failed to emit contract enforcement event:', err instanceof Error ? err.message : String(err));
    }

    // Fetch relay health — shows the relay's identity (signing key) and which
    // policies/models it has admitted. The contract's enforcement_policy_hash
    // must be in this set for the relay to accept the session.
    try {
      const healthRes = await fetch(`${RELAY_URL}/health`);
      if (healthRes.ok) {
        relayHealth = await healthRes.json() as Record<string, unknown>;
        const policySummary = relayHealth.policy_summary as Record<string, unknown> | undefined;
        events.emit({
          ts: new Date().toISOString(),
          type: 'system',
          agent: 'relay_policy',
          payload: {
            policy_id: policySummary?.policy_id ?? 'unknown',
            policy_hash: policySummary?.policy_hash ?? 'unknown',
            model_profile_allowlist: policySummary?.model_profile_allowlist ?? [],
            provider_allowlist: policySummary?.provider_allowlist ?? [],
            enforcement_rules: policySummary?.enforcement_rules ?? [],
            entropy_constraints: policySummary?.entropy_constraints ?? null,
            verifying_key_hex: relayHealth.verifying_key_hex ?? 'unknown',
            model_id: relayHealth.model_id ?? 'unknown',
          },
        });
      }
    } catch (err) {
      console.warn('Failed to fetch relay health for policy event:', err instanceof Error ? err.message : String(err));
    }

    // Load prompts — use request body if provided, else fall back to files
    const alicePrompt = (req.body?.alicePrompt as string) || loadPrompt('alice');
    const bobPrompt = (req.body?.bobPrompt as string) || loadPrompt('bob');

    const aliceParams = {
      name: 'alice',
      provider,
      registry: aliceRegistry,
      systemPrompt: SYSTEM_PROMPT,
      events,
      state: aliceState,
      queue: aliceQueue,
    };

    const bobParams = {
      name: 'bob',
      provider,
      registry: bobRegistry,
      systemPrompt: SYSTEM_PROMPT,
      events,
      state: bobState,
      queue: bobQueue,
    };

    res.json({ ok: true, runFile });

    // Send initial messages simultaneously — triggers immediate LLM bursts
    // These don't await each other; they both enqueue bursts independently
    sendUserMessage(aliceParams, alicePrompt).catch((err) => {
      console.error('Alice initial message failed:', err);
      events.emitSystem(`Alice start error: ${err instanceof Error ? err.message : 'Unknown'}`);
    });
    sendUserMessage(bobParams, bobPrompt).catch((err) => {
      console.error('Bob initial message failed:', err);
      events.emitSystem(`Bob start error: ${err instanceof Error ? err.message : 'Unknown'}`);
    });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

// Send a mid-run message to a specific agent
app.post('/api/message', async (req, res) => {
  const agent = req.body?.agent as string | undefined;
  const message = req.body?.message as string | undefined;
  // Optional client-assigned dedup ID — echoed back in the SSE user_message event
  // so the client can suppress the echo for messages it already rendered optimistically.
  const localId = typeof req.body?.localId === 'number' ? req.body.localId as number : undefined;

  if (agent !== 'alice' && agent !== 'bob') {
    res.status(400).json({ error: 'agent must be "alice" or "bob"' });
    return;
  }
  if (!message || typeof message !== 'string' || !message.trim()) {
    res.status(400).json({ error: 'message is required' });
    return;
  }

  const state = agent === 'alice' ? aliceState : bobState;
  if (!state.started) {
    res.status(409).json({ error: `${agent} has not started yet` });
    return;
  }

  const params = {
    name: agent,
    provider,
    registry: agent === 'alice' ? aliceRegistry : bobRegistry,
    systemPrompt: SYSTEM_PROMPT,
    events,
    state,
    queue: agent === 'alice' ? aliceQueue : bobQueue,
  };

  events.emitUserMessage(agent, message.trim(), localId);
  res.json({ ok: true });

  sendUserMessage(params, message.trim()).catch((err) => {
    console.error(`${agent} mid-run message failed:`, err);
    events.emitSystem(`${agent} message error: ${err instanceof Error ? err.message : 'Unknown'}`);
  });
});

// Verify receipt signature — supports both v1 and v2 receipts via shared verifier
app.post('/api/verify-receipt', async (req, res) => {
  try {
    const { receipt } = req.body as {
      receipt?: Record<string, unknown>;
    };

    if (!receipt) {
      res.status(400).json({ verified: false, error: 'receipt is required' });
      return;
    }

    let pubKeyHex: string;
    try {
      pubKeyHex = await fetchRelayPublicKey(RELAY_URL);
    } catch (err) {
      res.json({ verified: false, error: `Could not fetch relay public key: ${err instanceof Error ? err.message : String(err)}` });
      return;
    }

    const result = verifyReceipt(receipt, pubKeyHex);
    res.json({
      verified: result.valid,
      schema_version: result.schema_version,
      assurance_level: result.assurance_level,
      operator_id: result.operator_id,
      errors: result.errors,
      warnings: result.warnings,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ verified: false, error: msg });
  }
});

// Reset — clear state for a new run
app.post('/api/reset', async (_req, res) => {
  try {
    // Abort current heartbeat loops
    abortController.abort();

    // Stop both AFAL transports
    for (const [name, transport] of [['Bob', bobTransport], ['Alice', aliceTransport]] as const) {
      try {
        await transport.stop();
      } catch (stopErr) {
        const msg = stopErr instanceof Error ? stopErr.message : String(stopErr);
        console.error(`Failed to stop ${name} transport during reset:`, msg);
        events.emitSystem(`Warning: ${name} transport stop failed: ${msg}`);
      }
    }

    // Clear agent state
    aliceState.messages = [];
    aliceState.started = false;
    aliceState.turnCount = 0;
    aliceState.status = 'idle';
    bobState.messages = [];
    bobState.started = false;
    bobState.turnCount = 0;
    bobState.status = 'idle';

    // Reset queues
    aliceQueue.reset();
    bobQueue.reset();

    // Stop recording
    events.stopRecording();

    events.emitSystem('Reset — recreating transports and heartbeats');

    // Recreate transports, registries, and restart heartbeat loops
    await setupAndStartHeartbeats();

    res.json({ ok: true });
  } catch (error) {
    const msg = error instanceof Error ? error.message : 'Unknown error';
    res.status(500).json({ error: msg });
  }
});

// List recorded runs
app.get('/api/runs', (_req, res) => {
  res.json({ runs: listRuns(RUNS_DIR) });
});

// Replay a recorded run
app.get('/api/replay', (req, res) => {
  const file = req.query['file'] as string | undefined;
  const speed = parseFloat(req.query['speed'] as string ?? '1');

  if (!file) {
    res.status(400).json({ error: 'file parameter required' });
    return;
  }

  // Sanitize filename — no path traversal
  const safeName = path.basename(file);
  const filePath = path.join(RUNS_DIR, safeName);

  if (!fs.existsSync(filePath)) {
    res.status(404).json({ error: 'Run file not found' });
    return;
  }

  replayToSSE(filePath, res, speed).catch((error) => {
    console.error('Replay error:', error);
    try {
      const errEvent = JSON.stringify({
        type: 'error', agent: 'system', ts: new Date().toISOString(),
        payload: { error: `Replay failed: ${error instanceof Error ? error.message : String(error)}` },
      });
      res.write(`data: ${errEvent}\n\n`);
      res.end();
    } catch { /* client already disconnected */ }
  });
});

// ── Start server ─────────────────────────────────────────────────────────

app.listen(PORT, async () => {
  console.log(`AgentVault Demo UI running at http://localhost:${PORT}`);
  console.log(`Relay URL: ${RELAY_URL}`);
  console.log(`Runs directory: ${RUNS_DIR}`);

  // Set up transports and start heartbeat loops at server startup
  try {
    await setupAndStartHeartbeats();
  } catch (error) {
    console.error('Failed to initialize:', error);
    process.exit(1);
  }
});
