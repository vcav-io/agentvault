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
const RELAY_URL = process.env['VCAV_RELAY_URL'] ?? 'http://localhost:3100';
const RUNS_DIR = process.env['DEMO_RUNS_DIR'] ?? path.join(DEMO_DIR, 'runs');
const AFAL_PORT = 3201;

// ── Load .env ────────────────────────────────────────────────────────────

// Try loading from package dir, then from repo root
dotenvConfig({ path: path.join(DEMO_DIR, '.env') });
dotenvConfig({ path: path.resolve(DEMO_DIR, '../../.env') });

// ── Provider setup ───────────────────────────────────────────────────────

function createProvider(): LLMProvider {
  const provider = process.env['PROVIDER']?.toLowerCase();

  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when PROVIDER=openai');
    console.log('Using OpenAI provider');
    return new OpenAIProvider(apiKey);
  }

  if (provider === 'anthropic') {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required when PROVIDER=anthropic');
    const model = process.env['MODEL'];
    console.log(`Using Anthropic provider${model ? ` (model: ${model})` : ''}`);
    return new AnthropicProvider(apiKey, model);
  }

  if (provider === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when PROVIDER=gemini');
    const model = process.env['MODEL'];
    console.log(`Using Gemini provider${model ? ` (model: ${model})` : ''}`);
    return new GeminiProvider(apiKey, model);
  }

  // Auto-detection fallback
  if (process.env['ANTHROPIC_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected Anthropic from API key. Set PROVIDER=anthropic to suppress this warning.');
    return new AnthropicProvider(process.env['ANTHROPIC_API_KEY']);
  }

  if (process.env['OPENAI_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected OpenAI from API key. Set PROVIDER=openai to suppress this warning.');
    return new OpenAIProvider(process.env['OPENAI_API_KEY']);
  }

  if (process.env['GEMINI_API_KEY']) {
    console.warn('WARNING: PROVIDER not set. Auto-detected Gemini from API key. Set PROVIDER=gemini to suppress this warning.');
    return new GeminiProvider(process.env['GEMINI_API_KEY']);
  }

  throw new Error(
    'No LLM provider configured. Set PROVIDER=anthropic|openai|gemini with the matching API key in .env',
  );
}

function createHeartbeatProvider(): LLMProvider {
  const provider = process.env['PROVIDER']?.toLowerCase();

  // Match createProvider()'s detection order: explicit > Anthropic > OpenAI
  if (provider === 'openai') {
    const apiKey = process.env['OPENAI_API_KEY'];
    if (!apiKey) throw new Error('OPENAI_API_KEY is required when PROVIDER=openai');
    const model = process.env['HEARTBEAT_MODEL'] ?? 'gpt-4o-mini';
    console.log(`Heartbeat model: ${model}`);
    return new OpenAIProvider(apiKey, model);
  }

  if (provider === 'gemini') {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY is required when PROVIDER=gemini');
    const model = process.env['HEARTBEAT_MODEL'] ?? 'gemini-2.5-flash-lite';
    console.log(`Heartbeat model: ${model}`);
    return new GeminiProvider(apiKey, model);
  }

  if (provider === 'anthropic' || process.env['ANTHROPIC_API_KEY']) {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required for heartbeat provider');
    const model = process.env['HEARTBEAT_MODEL'] ?? 'claude-haiku-4-5-20251001';
    console.log(`Heartbeat model: ${model}`);
    return new AnthropicProvider(apiKey, model);
  }

  if (process.env['OPENAI_API_KEY']) {
    const model = process.env['HEARTBEAT_MODEL'] ?? 'gpt-4o-mini';
    console.log(`Heartbeat model: ${model}`);
    return new OpenAIProvider(process.env['OPENAI_API_KEY'], model);
  }

  if (process.env['GEMINI_API_KEY']) {
    const model = process.env['HEARTBEAT_MODEL'] ?? 'gemini-2.5-flash-lite';
    console.log(`Heartbeat model: ${model}`);
    return new GeminiProvider(process.env['GEMINI_API_KEY'], model);
  }

  throw new Error('No API key found for heartbeat provider');
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

const SYSTEM_PROMPT = `You are a helpful AI assistant participating in a private mediation session.
You have access to AgentVault tools for secure bounded-disclosure communication.

IMPORTANT:
- When you receive a [Heartbeat] message, run this checklist:
  1. Check inbox for pending session invites or messages
  2. Check active sessions for any required responses
  3. If work found, take the next appropriate action
  4. If nothing to do, reply with exactly HEARTBEAT_OK and nothing else
- When taking actions, give the user a brief one-sentence status update explaining what you're doing at a high level (e.g. "Setting up a private mediation channel with Bob." or "I've received a mediation invite — joining the session now."). Keep these extremely concise.
- Follow tool response instructions exactly.
- When relay_signal returns action_required = CALL_AGAIN, call it again with ONLY the resume_token.
- When the session completes, summarize the bounded signal you received.
- Do NOT reveal or quote the content of my_input in your responses.`;

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
  process.env['VCAV_RELAY_URL'] = RELAY_URL;

  // Generate identities
  const alice = generateIdentity();
  const bob = generateIdentity();
  events.emitSystem('Generated agent identities');

  // Build Bob's AFAL transport (responder — listens on HTTP)
  const bobDescriptor = buildDescriptor('bob', bob.seedHex, bob.pubKeyHex, AFAL_PORT);

  const bobPolicy: AdmissionPolicy = {
    trustedAgents: [{ agentId: 'alice', publicKeyHex: alice.pubKeyHex }] as TrustedAgent[],
    allowedPurposeCodes: ['MEDIATION', 'COMPATIBILITY'],
    allowedLaneIds: ['API_MEDIATED'],
    maxEntropyBits: 256,
    defaultTier: 'DENY',
  };

  const bobTransportConfig: DirectAfalTransportConfig = {
    agentId: 'bob',
    seedHex: bob.seedHex,
    localDescriptor: bobDescriptor,
    respondMode: { httpPort: AFAL_PORT, bindAddress: '127.0.0.1', policy: bobPolicy },
  };

  bobTransport = new DirectAfalTransport(bobTransportConfig);
  await bobTransport.start();
  events.emitSystem(`Bob AFAL transport started on port ${AFAL_PORT}`);

  // Build Alice's AFAL transport (initiator — uses Bob's descriptor URL)
  const aliceDescriptor = buildDescriptor('alice', alice.seedHex, alice.pubKeyHex);

  const aliceTransportConfig: DirectAfalTransportConfig = {
    agentId: 'alice',
    seedHex: alice.seedHex,
    localDescriptor: aliceDescriptor,
    peerDescriptorUrl: `http://127.0.0.1:${AFAL_PORT}/afal/descriptor`,
  };

  aliceTransport = new DirectAfalTransport(aliceTransportConfig);

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
    // Start JSONL recording
    const runFile = events.startRecording(RUNS_DIR);
    events.emitSystem(`Recording to ${runFile}`);

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

// Reset — clear state for a new run
app.post('/api/reset', async (_req, res) => {
  try {
    // Abort current heartbeat loops
    abortController.abort();

    // Stop Bob's transport
    try {
      await bobTransport.stop();
    } catch (stopErr) {
      const msg = stopErr instanceof Error ? stopErr.message : String(stopErr);
      console.error('Failed to stop Bob transport during reset:', msg);
      events.emitSystem(`Warning: Bob transport stop failed: ${msg}`);
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
