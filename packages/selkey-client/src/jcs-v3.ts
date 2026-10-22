/**
 * RFC 8785 (JCS) canonicalisation with the receipt v3 profile.
 *
 * Normative reference: vault-family-core `docs/receipt-v3.md`, section 2.
 *
 * - `canonicalizeV3(value)` serialises an already-parsed value with RFC 8785
 *   (the `canonicalize` package, by an RFC 8785 author) after enforcing the
 *   v3 input restrictions: every number finite with magnitude at most
 *   2^53 - 1, and no lone UTF-16 surrogates in strings or member names.
 * - `parseJsonStrict(text)` parses JSON text and rejects what `JSON.parse`
 *   silently accepts or loses: repeated member names, lone surrogates,
 *   out-of-range numbers and trailing content. It also records the literal
 *   text of every number so integer-typed fields can be checked lexically.
 */

import canonicalize from 'canonicalize';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';

/** `receipt_canonicalization` value for v3 receipts. */
export const CANONICALIZATION_V3 = 'JCS_RFC8785';

/** Largest number magnitude accepted by the v3 profile (2^53 - 1). */
export const MAX_SAFE_INTEGER_V3 = Number.MAX_SAFE_INTEGER;

/** Maximum nesting depth accepted by the strict parser (matches serde_json). */
const MAX_DEPTH = 128;

export type JcsErrorCode = 'PARSE_ERROR' | 'DUPLICATE_KEY' | 'NUMBER_OUT_OF_RANGE';

export class JcsError extends Error {
  constructor(
    public readonly code: JcsErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JcsError';
  }
}

/** Number literals as written in the source text, keyed by JSON Pointer. */
export type NumberLexemes = Map<string, string>;

export interface StrictParseResult {
  value: unknown;
  numberLexemes: NumberLexemes;
}

/** True if `s` contains no lone UTF-16 surrogate. */
export function isWellFormedString(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = i + 1 < s.length ? s.charCodeAt(i + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return false;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function pointerEscape(token: string): string {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

/** Set an own, enumerable property (safe for names such as `__proto__`). */
function defineMember(obj: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(obj, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

const NUMBER_RE = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/y;

class StrictParser {
  private pos = 0;
  readonly lexemes: NumberLexemes = new Map();

  constructor(private readonly text: string) {}

  parse(): unknown {
    this.skipWs();
    const value = this.parseValue('', 0);
    this.skipWs();
    if (this.pos !== this.text.length) {
      throw new JcsError('PARSE_ERROR', `trailing content at offset ${this.pos}`);
    }
    return value;
  }

  private fail(msg: string): never {
    throw new JcsError('PARSE_ERROR', `${msg} at offset ${this.pos}`);
  }

  private skipWs(): void {
    while (this.pos < this.text.length) {
      const c = this.text.charCodeAt(this.pos);
      if (c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d) this.pos++;
      else break;
    }
  }

  private parseValue(path: string, depth: number): unknown {
    if (depth > MAX_DEPTH) this.fail('nesting too deep');
    const c = this.text[this.pos];
    if (c === '{') return this.parseObject(path, depth + 1);
    if (c === '[') return this.parseArray(path, depth + 1);
    if (c === '"') return this.parseString();
    if (c === 't') return this.literal('true', true);
    if (c === 'f') return this.literal('false', false);
    if (c === 'n') return this.literal('null', null);
    if (c === '-' || (c !== undefined && c >= '0' && c <= '9')) return this.parseNumber(path);
    return this.fail('unexpected character');
  }

  private literal(word: string, value: unknown): unknown {
    if (this.text.startsWith(word, this.pos)) {
      this.pos += word.length;
      return value;
    }
    return this.fail('invalid literal');
  }

  private parseNumber(path: string): number {
    NUMBER_RE.lastIndex = this.pos;
    const m = NUMBER_RE.exec(this.text);
    if (!m || m[0].length === 0) return this.fail('invalid number');
    const lexeme = m[0];
    this.pos += lexeme.length;
    const n = Number(lexeme);
    if (!Number.isFinite(n) || Math.abs(n) > MAX_SAFE_INTEGER_V3) {
      throw new JcsError('NUMBER_OUT_OF_RANGE', `number out of range at ${path || '/'}`);
    }
    this.lexemes.set(path, lexeme);
    return n;
  }

  private parseString(): string {
    this.pos++; // opening quote
    let out = '';
    let start = this.pos;
    for (;;) {
      if (this.pos >= this.text.length) this.fail('unterminated string');
      const ch = this.text.charCodeAt(this.pos);
      if (ch === 0x22) {
        out += this.text.slice(start, this.pos);
        this.pos++;
        break;
      }
      if (ch < 0x20) this.fail('control character in string');
      if (ch === 0x5c) {
        out += this.text.slice(start, this.pos);
        this.pos++;
        const esc = this.text[this.pos];
        this.pos++;
        switch (esc) {
          case '"':
            out += '"';
            break;
          case '\\':
            out += '\\';
            break;
          case '/':
            out += '/';
            break;
          case 'b':
            out += '\b';
            break;
          case 'f':
            out += '\f';
            break;
          case 'n':
            out += '\n';
            break;
          case 'r':
            out += '\r';
            break;
          case 't':
            out += '\t';
            break;
          case 'u': {
            const hex = this.text.slice(this.pos, this.pos + 4);
            if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('invalid unicode escape');
            out += String.fromCharCode(parseInt(hex, 16));
            this.pos += 4;
            break;
          }
          default:
            this.fail('invalid escape');
        }
        start = this.pos;
        continue;
      }
      this.pos++;
    }
    if (!isWellFormedString(out)) {
      throw new JcsError('PARSE_ERROR', 'lone surrogate in string');
    }
    return out;
  }

  private parseArray(path: string, depth: number): unknown[] {
    this.pos++;
    const arr: unknown[] = [];
    this.skipWs();
    if (this.text[this.pos] === ']') {
      this.pos++;
      return arr;
    }
    for (;;) {
      this.skipWs();
      arr.push(this.parseValue(`${path}/${arr.length}`, depth));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === ']') {
        this.pos++;
        return arr;
      }
      this.fail('expected , or ]');
    }
  }

  private parseObject(path: string, depth: number): Record<string, unknown> {
    this.pos++;
    const obj: Record<string, unknown> = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.text[this.pos] === '}') {
      this.pos++;
      return obj;
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') this.fail('expected member name');
      const key = this.parseString();
      if (seen.has(key)) {
        throw new JcsError('DUPLICATE_KEY', `repeated member name ${JSON.stringify(key)}`);
      }
      seen.add(key);
      this.skipWs();
      if (this.text[this.pos] !== ':') this.fail('expected :');
      this.pos++;
      this.skipWs();
      defineMember(obj, key, this.parseValue(`${path}/${pointerEscape(key)}`, depth));
      this.skipWs();
      const c = this.text[this.pos];
      if (c === ',') {
        this.pos++;
        continue;
      }
      if (c === '}') {
        this.pos++;
        return obj;
      }
      this.fail('expected , or }');
    }
  }
}

/**
 * Parse JSON text strictly (receipt v3 profile).
 *
 * Rejects repeated member names at any depth, lone surrogates, numbers with
 * magnitude above 2^53 - 1, non-JSON literals (`NaN`, `Infinity`) and
 * trailing content.
 */
export function parseJsonStrictWithLexemes(text: string): StrictParseResult {
  const parser = new StrictParser(text);
  const value = parser.parse();
  return { value, numberLexemes: parser.lexemes };
}

/** As {@link parseJsonStrictWithLexemes}, returning only the value. */
export function parseJsonStrict(text: string): unknown {
  return parseJsonStrictWithLexemes(text).value;
}

/** True if `lexeme` is a JSON integer literal without sign, fraction or exponent. */
export function isLexicalUnsignedInteger(lexeme: string): boolean {
  return /^(0|[1-9][0-9]*)$/.test(lexeme);
}

/**
 * Check an already-parsed value against the v3 profile: plain JSON values
 * only, finite numbers with magnitude at most 2^53 - 1, well-formed strings
 * and member names.
 */
export function checkV3Profile(value: unknown, path = ''): void {
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new JcsError('PARSE_ERROR', `non-finite number at ${path || '/'}`);
    }
    if (Math.abs(value) > MAX_SAFE_INTEGER_V3) {
      throw new JcsError('NUMBER_OUT_OF_RANGE', `number out of range at ${path || '/'}`);
    }
    return;
  }
  if (typeof value === 'string') {
    if (!isWellFormedString(value)) {
      throw new JcsError('PARSE_ERROR', `lone surrogate at ${path || '/'}`);
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((v, i) => checkV3Profile(v, `${path}/${i}`));
    return;
  }
  if (typeof value === 'object') {
    const proto = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new JcsError('PARSE_ERROR', `not a plain JSON object at ${path || '/'}`);
    }
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (!isWellFormedString(k)) {
        throw new JcsError('PARSE_ERROR', `lone surrogate in member name at ${path || '/'}`);
      }
      if (v === undefined) {
        throw new JcsError('PARSE_ERROR', `undefined member at ${path}/${pointerEscape(k)}`);
      }
      checkV3Profile(v, `${path}/${pointerEscape(k)}`);
    }
    return;
  }
  throw new JcsError('PARSE_ERROR', `value is not JSON at ${path || '/'}`);
}

/** RFC 8785 canonical form of `value` under the v3 profile. */
export function canonicalizeV3(value: unknown): string {
  checkV3Profile(value);
  const out = canonicalize(value);
  if (out === undefined) {
    throw new JcsError('PARSE_ERROR', 'value has no JSON representation');
  }
  return out;
}

/** Lowercase hex SHA-256 of bytes or of a string's UTF-8 encoding. */
export function sha256Hex(data: Uint8Array | string): string {
  return bytesToHex(sha256(typeof data === 'string' ? utf8ToBytes(data) : data));
}

/** `H(JCS(value))`: lowercase hex SHA-256 of the v3 canonical form. */
export function hashV3(value: unknown): string {
  return sha256Hex(canonicalizeV3(value));
}

/** Constant-time comparison of two equal-length byte arrays. */
export function constantTimeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

/** True if `s` is exactly `len` lowercase hex characters. */
export function isLowerHex(s: unknown, len: number): s is string {
  return typeof s === 'string' && s.length === len && /^[0-9a-f]*$/.test(s);
}
