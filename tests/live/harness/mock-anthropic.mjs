#!/usr/bin/env node
/**
 * mock-anthropic.mjs — Schema-driven mock Anthropic API server
 *
 * Handles POST /v1/messages and GET /health.
 * Reads `output_config.format.schema` or `json_schema.schema` from the
 * request and generates deterministic responses that satisfy the schema.
 *
 * PORT env var configures the listen port (default 3199).
 */

import http from 'node:http';

const PORT = parseInt(process.env.PORT ?? '3199', 10);

// ---------------------------------------------------------------------------
// Schema-driven response generation
// ---------------------------------------------------------------------------

/**
 * Generate a minimal-valid value for a JSON Schema node.
 * @param {object} schema
 * @param {number} depth - recursion guard
 * @returns {unknown}
 */
function generateFromSchema(schema, depth = 0) {
  if (depth > 8) return null;

  if (!schema || typeof schema !== 'object') return 'mock-value';

  // Handle allOf / oneOf / anyOf by using first branch
  if (Array.isArray(schema.allOf) && schema.allOf.length > 0) {
    return generateFromSchema(schema.allOf[0], depth + 1);
  }
  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return generateFromSchema(schema.oneOf[0], depth + 1);
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return generateFromSchema(schema.anyOf[0], depth + 1);
  }

  const type = schema.type;

  if (type === 'object' || (schema.properties && !type)) {
    const obj = {};
    const required = Array.isArray(schema.required) ? schema.required : [];
    const props = schema.properties ?? {};

    // Fill required properties first, then all if no required specified
    const keys = required.length > 0 ? required : Object.keys(props);
    for (const key of keys) {
      const propSchema = props[key] ?? {};
      obj[key] = generateFromSchema(propSchema, depth + 1);
    }
    return obj;
  }

  if (type === 'array') {
    const itemSchema = schema.items ?? {};
    return [generateFromSchema(itemSchema, depth + 1)];
  }

  if (type === 'string') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }
    if (schema.const !== undefined) return schema.const;
    const max = schema.maxLength;
    if (max != null && max < 20) {
      return 'x'.repeat(max);
    }
    return 'mock-string-value';
  }

  if (type === 'number' || type === 'integer') {
    if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
    if (schema.const !== undefined) return schema.const;
    const min = schema.minimum ?? schema.exclusiveMinimum ?? 0;
    const max = schema.maximum ?? schema.exclusiveMaximum ?? 100;
    return typeof min === 'number' ? min : 0;
  }

  if (type === 'boolean') {
    return false;
  }

  if (type === 'null') return null;

  // Fallback: if has enum, pick first
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  return 'mock-value';
}

/**
 * Extract the output schema from an Anthropic messages request body.
 * Supports both new-style output_config.format and tool-use json_schema patterns.
 * @param {object} body
 * @returns {object|null}
 */
function extractSchema(body) {
  // New-style: output_config.format.schema or output_config.format.json_schema
  const outputConfig = body?.output_config;
  if (outputConfig?.format?.schema) return outputConfig.format.schema;
  if (outputConfig?.format?.json_schema) return outputConfig.format.json_schema;

  // Tool-use: tools[*].input_schema where tool is selected as forced
  if (Array.isArray(body?.tools) && body?.tool_choice?.name) {
    const forced = body.tools.find((t) => t.name === body.tool_choice.name);
    if (forced?.input_schema) return forced.input_schema;
  }
  if (Array.isArray(body?.tools) && body.tools.length > 0) {
    return body.tools[0]?.input_schema ?? null;
  }

  return null;
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

  // Health endpoint
  if (method === 'GET' && url === '/health') {
    return sendJson(res, 200, { status: 'ok', server: 'mock-anthropic' });
  }

  // Messages endpoint
  if (method === 'POST' && url === '/v1/messages') {
    let body;
    try {
      body = await readBody(req);
    } catch {
      return sendJson(res, 400, { error: 'bad_request', message: 'Failed to parse body' });
    }

    const schema = extractSchema(body);
    let generated;

    if (schema) {
      generated = generateFromSchema(schema);
    } else {
      // No schema — return a generic text response
      generated = { result: 'ok', mock: true };
    }

    const text = typeof generated === 'string' ? generated : JSON.stringify(generated);

    const response = {
      id: `msg_mock_${Date.now()}`,
      type: 'message',
      role: 'assistant',
      model: 'mock-model',
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: text.length },
      content: [
        {
          type: 'text',
          text,
        },
      ],
    };

    return sendJson(res, 200, response);
  }

  // 404 for anything else
  sendJson(res, 404, { error: 'not_found', path: url });
});

server.listen(PORT, () => {
  console.log(`mock-anthropic listening on port ${PORT}`);
});

server.on('error', (err) => {
  console.error('mock-anthropic server error:', err);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => server.close(() => process.exit(0)));
process.on('SIGINT', () => server.close(() => process.exit(0)));
