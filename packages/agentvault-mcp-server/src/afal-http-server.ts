/**
 * AfalHttpServer — lightweight HTTP server for AFAL RESPOND mode.
 *
 * 4 routes:
 *   GET  /afal/descriptor → agent descriptor
 *   POST /afal/propose    → AfalResponder.handlePropose
 *   POST /afal/commit     → AfalResponder.handleCommit
 *   POST /afal/negotiate  → bounded contract-offer selection
 *   POST /a2a/send-message → minimal A2A wrapper for propose/session tokens
 *
 * Guards:
 *   - 64KB body size limit
 *   - Content-Type: application/json enforcement on POST
 *   - 16 max concurrent requests (503 if exceeded)
 *   - Binds to 127.0.0.1 by default (loopback only)
 */

import { createServer } from 'node:http';
import type { Server, IncomingMessage, ServerResponse } from 'node:http';
import type { AfalResponder } from './afal-responder.js';
import type { AgentDescriptor } from './direct-afal-transport.js';
import { buildAgentCard } from './a2a-agent-card.js';
import {
  A2A_SEND_MESSAGE_PATH,
  AGENTVAULT_ADMIT_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
  AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
  AGENTVAULT_DENY_MEDIA_TYPE,
  AGENTVAULT_PROPOSE_MEDIA_TYPE,
  AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
  buildA2ATaskResponse,
  parseA2ASendMessagePart,
} from './a2a-messages.js';
import {
  parseContractOfferProposal,
  parseSupportedContractOffers,
  selectNegotiatedContractOffer,
} from './contract-negotiation.js';
import {
  supportsBespokePrecontractNegotiation,
  validateBespokeContractSelection,
} from './bespoke-contracts.js';
import { listKnownModelProfiles } from './model-profiles.js';

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONCURRENT = 16;

export interface AfalHttpServerConfig {
  port: number;
  bindAddress?: string;
  responder: AfalResponder;
  localDescriptor: AgentDescriptor;
  relayUrl?: string;
  supportedPurposes?: string[];
  advertiseAfalEndpoint?: boolean;
  seedHex?: string;
}

export class AfalHttpServer {
  private readonly config: AfalHttpServerConfig;
  private server: Server | null = null;
  private inflight = 0;
  private _actualPort: number | null = null;
  private _localDescriptor: AgentDescriptor;

  constructor(config: AfalHttpServerConfig) {
    this.config = config;
    this._localDescriptor = config.localDescriptor;
  }

  get port(): number {
    return this._actualPort ?? this.config.port;
  }

  get baseUrl(): string {
    const addr = this.config.bindAddress ?? '127.0.0.1';
    return `http://${addr}:${this.port}`;
  }

  /** Update the served descriptor (e.g. after port 0 resolves to actual port). */
  setDescriptor(descriptor: AgentDescriptor): void {
    this._localDescriptor = descriptor;
  }

  async start(): Promise<void> {
    if (this.server) return;

    const srv = createServer((req, res) => this.handleRequest(req, res));
    this.server = srv;

    const bindAddress = this.config.bindAddress ?? '127.0.0.1';
    await new Promise<void>((resolve, reject) => {
      srv.on('error', reject);
      srv.listen(this.config.port, bindAddress, () => {
        const addr = srv.address();
        if (addr && typeof addr === 'object') {
          this._actualPort = addr.port;
        }
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    const srv = this.server;
    this.server = null;
    await new Promise<void>((resolve) => srv.close(() => resolve()));
  }

  get localDescriptor(): AgentDescriptor {
    return this._localDescriptor;
  }

  get agentCard() {
    const supportedContractOffers = parseSupportedContractOffers(
      this._localDescriptor.capabilities['supported_contract_offers'],
    ) ?? undefined;
    return buildAgentCard({
      baseUrl: this.baseUrl,
      descriptor: this._localDescriptor,
      supportedPurposes: this.config.supportedPurposes ?? [],
      relayUrl: this.config.relayUrl,
      includeAfalEndpoint: this.config.advertiseAfalEndpoint,
      supportedContractOffers,
      seedHex: this.config.seedHex,
      supportsBespokeContractNegotiation: supportsBespokePrecontractNegotiation(),
    });
  }

  /** Extracted for testability — handles a single HTTP request. */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Concurrent request guard
    if (this.inflight >= MAX_CONCURRENT) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many concurrent requests' }));
      return;
    }
    this.inflight++;

    let doneCalled = false;
    const done = () => {
      if (!doneCalled) {
        doneCalled = true;
        this.inflight--;
      }
    };
    const method = req.method ?? '';
    const url = req.url ?? '';

    if (method === 'GET' && url === '/afal/descriptor') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._localDescriptor));
      done();
      return;
    }

    if (method === 'GET' && url === '/.well-known/agent-card.json') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this.agentCard));
      done();
      return;
    }

    if (
      method === 'POST' &&
      (url === '/afal/propose' ||
        url === '/afal/commit' ||
        url === '/afal/negotiate' ||
        url === A2A_SEND_MESSAGE_PATH)
    ) {
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.startsWith('application/json')) {
        res.writeHead(415, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Content-Type must be application/json' }));
        done();
        return;
      }

      this.readBody(req, (err, body) => {
        if (err) {
          const status = err === 'BODY_TOO_LARGE' ? 413 : 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: err }));
          done();
          return;
        }

        void (async () => {
          if (url === '/afal/propose') {
            const result = this.config.responder.handlePropose(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result.response));
          } else if (url === '/afal/negotiate') {
            const proposal = parseContractOfferProposal(body);
            if (!proposal) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Invalid contract-offer proposal body' }));
            } else {
              const supportedContractOffers =
                parseSupportedContractOffers(
                  this._localDescriptor.capabilities['supported_contract_offers'],
                ) ?? [];
              const selection = await selectNegotiatedContractOffer(
                proposal,
                {
                  supportedOffers: supportedContractOffers,
                  localAgentId: this._localDescriptor.agent_id,
                  supportsBespoke: supportsBespokePrecontractNegotiation(),
                  supportedModelProfiles: listKnownModelProfiles(),
                  validateBespokeContract: validateBespokeContractSelection,
                },
              );
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(selection));
            }
          } else if (url === A2A_SEND_MESSAGE_PATH) {
            const parsed = parseA2ASendMessagePart(body, [
              AGENTVAULT_PROPOSE_MEDIA_TYPE,
              AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
              AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE,
            ]);
            if (!parsed) {
              res.writeHead(400, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'Unsupported A2A message body' }));
            } else if (parsed.mediaType === AGENTVAULT_PROPOSE_MEDIA_TYPE) {
              const result = this.config.responder.handlePropose({ propose: parsed.data });
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify(
                  buildA2ATaskResponse({
                    mediaType:
                      result.outcome === 'ADMIT'
                        ? AGENTVAULT_ADMIT_MEDIA_TYPE
                        : AGENTVAULT_DENY_MEDIA_TYPE,
                    data: result.response,
                  }),
                ),
              );
            } else if (parsed.mediaType === AGENTVAULT_CONTRACT_OFFER_PROPOSAL_MEDIA_TYPE) {
              const proposal = parseContractOfferProposal(parsed.data);
              if (!proposal) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid contract-offer proposal body' }));
              } else {
                const supportedContractOffers =
                  parseSupportedContractOffers(
                    this._localDescriptor.capabilities['supported_contract_offers'],
                  ) ?? [];
                const selection = await selectNegotiatedContractOffer(
                  proposal,
                  {
                    supportedOffers: supportedContractOffers,
                    localAgentId: this._localDescriptor.agent_id,
                    supportsBespoke: supportsBespokePrecontractNegotiation(),
                    supportedModelProfiles: listKnownModelProfiles(),
                    validateBespokeContract: validateBespokeContractSelection,
                  },
                );
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(
                  JSON.stringify(
                    buildA2ATaskResponse({
                      mediaType: AGENTVAULT_CONTRACT_OFFER_SELECTION_MEDIA_TYPE,
                      data: selection,
                    }),
                  ),
                );
              }
            } else {
              const result = this.config.responder.handleCommit(parsed.data);
              const status = result.ok ? 200 : 400;
              res.writeHead(status, { 'Content-Type': 'application/json' });
              res.end(
                JSON.stringify(
                  buildA2ATaskResponse({
                    mediaType: AGENTVAULT_SESSION_TOKENS_MEDIA_TYPE,
                    data: result,
                  }),
                ),
              );
            }
          } else {
            const result = this.config.responder.handleCommit(body);
            const status = result.ok ? 200 : 400;
            res.writeHead(status, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          }
        })().catch((e) => {
          console.error(`AFAL ${url} handler threw:`, e);
          if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }).finally(() => {
          done();
        });
      });
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not found' }));
    done();
  }

  private readBody(
    req: IncomingMessage,
    callback: (err: string | null, body: unknown) => void,
  ): void {
    const chunks: Buffer[] = [];
    let size = 0;
    let called = false;

    const finish = (err: string | null, body: unknown) => {
      if (called) return;
      called = true;
      callback(err, body);
    };

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        finish('BODY_TOO_LARGE', null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(raw);
        finish(null, parsed);
      } catch {
        finish('Invalid JSON', null);
      }
    });

    req.on('error', () => {
      finish('Request error', null);
    });
  }
}
