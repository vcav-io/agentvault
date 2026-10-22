/**
 * JSONL file reader and replay stream.
 *
 * Reads a recorded JSONL file and re-emits events at original
 * timestamps (adjustable speed multiplier).
 */

import * as fs from 'node:fs';
import * as readline from 'node:readline';
import type { Response } from 'express';
import type { DemoEvent } from './events.js';

/**
 * Replay a JSONL file as an SSE stream.
 *
 * Events are sent with timing proportional to original timestamps.
 * Speed multiplier controls playback speed (1 = real-time, 2 = 2x, etc.).
 */
export async function replayToSSE(
  filePath: string,
  res: Response,
  speed = 1,
): Promise<void> {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const events: DemoEvent[] = [];

  const rl = readline.createInterface({
    input: fs.createReadStream(filePath),
    crlfDelay: Infinity,
  });

  let skippedLines = 0;
  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      events.push(JSON.parse(line) as DemoEvent);
    } catch {
      skippedLines++;
    }
  }
  if (skippedLines > 0) {
    console.warn(`Replay: ${skippedLines} malformed line(s) skipped in ${filePath}`);
  }

  if (events.length === 0) {
    res.write(`data: ${JSON.stringify({ type: 'system', agent: 'system', ts: new Date().toISOString(), payload: { message: 'No events in file' } })}\n\n`);
    res.end();
    return;
  }

  let closed = false;
  res.on('close', () => {
    closed = true;
  });

  const firstTs = new Date(events[0].ts).getTime();

  for (let i = 0; i < events.length; i++) {
    if (closed) break;

    const event = events[i];
    const eventTs = new Date(event.ts).getTime();

    // Compute delay from first event
    if (i > 0) {
      const prevTs = new Date(events[i - 1].ts).getTime();
      const delay = (eventTs - prevTs) / speed;
      if (delay > 0) {
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    if (closed) break;
    res.write(`data: ${JSON.stringify(event)}\n\n`);
  }

  // Signal end of replay
  if (!closed) {
    res.write(`data: ${JSON.stringify({ type: 'system', agent: 'system', ts: new Date().toISOString(), payload: { message: 'Replay complete' } })}\n\n`);
    res.end();
  }
}

/**
 * List available JSONL run files in a directory.
 */
export function listRuns(runsDir: string): string[] {
  if (!fs.existsSync(runsDir)) return [];
  return fs
    .readdirSync(runsDir)
    .filter((f) => f.endsWith('.jsonl'))
    .sort()
    .reverse();
}
