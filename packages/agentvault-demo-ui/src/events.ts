/**
 * Event bus: SSE broadcast + JSONL recording.
 *
 * Every event is broadcast to connected SSE clients and appended
 * to a JSONL file for later replay.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { Response } from 'express';

// ── Event types ──────────────────────────────────────────────────────────

export type EventType =
  | 'tool_call'
  | 'tool_result'
  | 'llm_text'
  | 'user_message'
  | 'agent_status'
  | 'system'
  | 'error';

export interface DemoEvent {
  ts: string;
  type: EventType;
  agent: string;
  payload: Record<string, unknown>;
}

// ── Event bus ────────────────────────────────────────────────────────────

export class EventBus {
  private clients: Set<Response> = new Set();
  private jsonlStream: fs.WriteStream | null = null;
  private runFile: string | null = null;

  /**
   * Start recording to a new JSONL file.
   */
  startRecording(runsDir: string): string {
    if (!fs.existsSync(runsDir)) {
      fs.mkdirSync(runsDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `run-${timestamp}.jsonl`;
    this.runFile = path.join(runsDir, filename);
    this.jsonlStream = fs.createWriteStream(this.runFile, { flags: 'a' });
    this.jsonlStream.on('error', (err) => {
      console.error('JSONL recording error:', err.message);
      this.jsonlStream = null;
    });
    return filename;
  }

  /**
   * Stop recording and close the JSONL file.
   */
  stopRecording(): void {
    if (this.jsonlStream) {
      this.jsonlStream.end();
      this.jsonlStream = null;
    }
  }

  /**
   * Add an SSE client.
   */
  addClient(res: Response): void {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }

  /**
   * Emit an event to all SSE clients and the JSONL file.
   */
  emit(event: DemoEvent): void {
    const json = JSON.stringify(event);

    // SSE broadcast
    for (const client of this.clients) {
      try {
        client.write(`data: ${json}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }

    // JSONL recording
    if (this.jsonlStream) {
      this.jsonlStream.write(json + '\n');
    }
  }

  /**
   * Convenience: emit a tool_call event.
   */
  emitToolCall(agent: string, tool: string, args: Record<string, unknown>): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'tool_call',
      agent,
      payload: { tool, args },
    });
  }

  /**
   * Convenience: emit a tool_result event.
   */
  emitToolResult(agent: string, tool: string, result: unknown): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'tool_result',
      agent,
      payload: { tool, result: result as Record<string, unknown> },
    });
  }

  /**
   * Convenience: emit an llm_text event.
   */
  emitLLMText(agent: string, text: string): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'llm_text',
      agent,
      payload: { text },
    });
  }

  /**
   * Convenience: emit a user_message event (mid-run chat from the human).
   */
  emitUserMessage(agent: string, text: string): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'user_message',
      agent,
      payload: { text },
    });
  }

  /**
   * Convenience: emit an agent_status event.
   */
  emitStatus(agent: string, status: string, detail?: string): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'agent_status',
      agent,
      payload: { status, ...(detail ? { detail } : {}) },
    });
  }

  /**
   * Convenience: emit a system event.
   */
  emitSystem(message: string): void {
    this.emit({
      ts: new Date().toISOString(),
      type: 'system',
      agent: 'system',
      payload: { message },
    });
  }

  /**
   * Get the current run file path.
   */
  getRunFile(): string | null {
    return this.runFile;
  }

  /**
   * Get number of connected SSE clients.
   */
  get clientCount(): number {
    return this.clients.size;
  }
}
