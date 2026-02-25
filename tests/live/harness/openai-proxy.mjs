#!/usr/bin/env node
/**
 * openai-proxy.mjs — OpenAI-to-Anthropic translation proxy
 *
 * Receives Anthropic-format POST /v1/messages, translates to OpenAI Chat
 * Completions format, forwards to OpenAI API, and translates the response
 * back to Anthropic format.
 *
 * Env vars:
 *   OPENAI_API_KEY  (required)
 *   OPENAI_MODEL    (default: gpt-4o)
 *   PORT            (default: 3199)
 */

import http from 'node:http';
import https from 'node:https';

const PORT = parseInt(process.env.PORT ?? '3199', 10);
const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? '';
const OPENAI_MODEL = process.env.OPENAI_MODEL ?? 'gpt-4o';
const OPENAI_HOST = 'api.openai.com';

if (!OPENAI_API_KEY) {
  console.error('openai-proxy: OPENAI_API_KEY is required');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Format translation helpers
// ---------------------------------------------------------------------------

/**
 * Translate Anthropic messages request to OpenAI chat completions request.
 * @param {object} anthropicReq
 * @returns {object} OpenAI request body
 */
function anthropicToOpenAI(anthropicReq) {
  const messages = [];

  // Extract system message
  if (anthropicReq.system) {
    messages.push({
      role: 'system',
      content: typeof anthropicReq.system === 'string'
        ? anthropicReq.system
        : JSON.stringify(anthropicReq.system),
    });
  }

  // Translate message array
  for (const msg of (anthropicReq.messages ?? [])) {
    let content;
    if (typeof msg.content === 'string') {
      content = msg.content;
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks to text
      content = msg.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n');
    } else {
      content = JSON.stringify(msg.content);
    }
    messages.push({ role: msg.role, content });
  }

  const openaiReq = {
    model: OPENAI_MODEL,
    messages,
    max_tokens: anthropicReq.max_tokens ?? 1024,
  };

  // Translate output_config to response_format if present
  const schema = anthropicReq?.output_config?.format?.schema
    ?? anthropicReq?.output_config?.format?.json_schema;
  if (schema) {
    openaiReq.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'output',
        strict: true,
        schema,
      },
    };
  } else if (anthropicReq?.output_config?.format?.type === 'json_object') {
    openaiReq.response_format = { type: 'json_object' };
  }

  return openaiReq;
}

/**
 * Translate OpenAI chat completions response to Anthropic messages response.
 * @param {object} openaiRes
 * @param {string} originalModel  — relay-requested model ID
 * @returns {object} Anthropic response
 */
function openAIToAnthropic(openaiRes, originalModel) {
  const choice = openaiRes.choices?.[0];
  const text = choice?.message?.content ?? '';

  return {
    id: `msg_oai_${openaiRes.id ?? Date.now()}`,
    type: 'message',
    role: 'assistant',
    model: originalModel ?? OPENAI_MODEL,
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : (choice?.finish_reason ?? 'end_turn'),
    stop_sequence: null,
    usage: {
      input_tokens: openaiRes.usage?.prompt_tokens ?? 0,
      output_tokens: openaiRes.usage?.completion_tokens ?? 0,
    },
    content: [{ type: 'text', text }],
  };
}

// ---------------------------------------------------------------------------
// OpenAI API call
// ---------------------------------------------------------------------------

function callOpenAI(body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const options = {
      hostname: OPENAI_HOST,
      port: 443,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        } catch (err) {
          reject(err);
        }
      });
    });

    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/health') {
    return sendJson(res, 200, { status: 'ok', server: 'openai-proxy' });
  }

  if (method === 'POST' && url === '/v1/messages') {
    let anthropicBody;
    try {
      anthropicBody = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: 'Failed to parse body' });
    }

    const openaiBody = anthropicToOpenAI(anthropicBody);

    let result;
    try {
      result = await callOpenAI(openaiBody);
    } catch (err) {
      console.error('openai-proxy: upstream error:', err);
      return sendJson(res, 502, { error: 'upstream_error', message: String(err) });
    }

    if (result.status !== 200) {
      return sendJson(res, result.status ?? 502, result.body);
    }

    const anthropicResponse = openAIToAnthropic(result.body, anthropicBody.model);
    return sendJson(res, 200, anthropicResponse);
  }

  sendJson(res, 404, { error: 'not_found', path: url });
});

server.listen(PORT, () => {
  console.log(`openai-proxy listening on port ${PORT} (model: ${OPENAI_MODEL})`);
});

server.on('error', (err) => {
  console.error('openai-proxy server error:', err);
  process.exit(1);
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
