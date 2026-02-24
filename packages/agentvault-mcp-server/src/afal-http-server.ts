/**
 * AfalHttpServer — lightweight HTTP server for AFAL RESPOND mode.
 *
 * 3 routes:
 *   GET  /afal/descriptor → agent descriptor
 *   POST /afal/propose    → AfalResponder.handlePropose
 *   POST /afal/commit     → AfalResponder.handleCommit
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

const MAX_BODY_BYTES = 64 * 1024;
const MAX_CONCURRENT = 16;

export interface AfalHttpServerConfig {
  port: number;
  bindAddress?: string;
  responder: AfalResponder;
  localDescriptor: AgentDescriptor;
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

  /** Extracted for testability — handles a single HTTP request. */
  handleRequest(req: IncomingMessage, res: ServerResponse): void {
    // Concurrent request guard
    if (this.inflight >= MAX_CONCURRENT) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Too many concurrent requests' }));
      return;
    }
    this.inflight++;

    const done = () => { this.inflight--; };
    const method = req.method ?? '';
    const url = req.url ?? '';

    if (method === 'GET' && url === '/afal/descriptor') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(this._localDescriptor));
      done();
      return;
    }

    if (method === 'POST' && (url === '/afal/propose' || url === '/afal/commit')) {
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

        if (url === '/afal/propose') {
          const result = this.config.responder.handlePropose(body);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.response));
        } else {
          const result = this.config.responder.handleCommit(body);
          const status = result.ok ? 200 : 400;
          res.writeHead(status, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result));
        }
        done();
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

    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        callback('BODY_TOO_LARGE', null);
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const parsed = JSON.parse(raw);
        callback(null, parsed);
      } catch {
        callback('Invalid JSON', null);
      }
    });

    req.on('error', () => {
      callback('Request error', null);
    });
  }
}
