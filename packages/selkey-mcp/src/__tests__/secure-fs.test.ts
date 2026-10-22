import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  InsecureStateFileError,
  acquireFileLock,
  appendPrivateLine,
  removeLockIfUnchanged,
  readPrivateJson,
  writePrivateJson,
} from '../secure-fs.js';

const posix = process.platform !== 'win32';
let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'selkey-securefs-'));
});
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

const mode = (p: string) => fs.statSync(p).mode & 0o777;

describe.skipIf(!posix)('secure-fs', () => {
  it('writes 0600 files inside a 0700 directory and reads them back', () => {
    const file = path.join(tmp, 'state', 'x.json');
    writePrivateJson(file, { a: 1 });
    expect(mode(path.join(tmp, 'state'))).toBe(0o700);
    expect(mode(file)).toBe(0o600);
    expect(readPrivateJson(file)).toEqual({ a: 1 });
  });

  it('returns undefined for a missing file', () => {
    expect(readPrivateJson(path.join(tmp, 'missing.json'))).toBeUndefined();
  });

  it('refuses to load a group- or world-writable file', () => {
    const file = path.join(tmp, 'state', 'x.json');
    writePrivateJson(file, { a: 1 });
    fs.chmodSync(file, 0o666);
    expect(() => readPrivateJson(file)).toThrow(InsecureStateFileError);
    fs.chmodSync(file, 0o620);
    expect(() => readPrivateJson(file)).toThrow(/group- or world-writable/);
  });

  it('refuses to load a file in a group-writable directory', () => {
    const file = path.join(tmp, 'state', 'x.json');
    writePrivateJson(file, { a: 1 });
    fs.chmodSync(path.join(tmp, 'state'), 0o770);
    expect(() => readPrivateJson(file)).toThrow(InsecureStateFileError);
  });

  it('refuses to load through a symlink', () => {
    const file = path.join(tmp, 'state', 'x.json');
    writePrivateJson(file, { a: 1 });
    const link = path.join(tmp, 'state', 'link.json');
    fs.symlinkSync(file, link);
    expect(() => readPrivateJson(link)).toThrow(/not a regular file/);
  });

  it('replaces a symlink at the destination instead of writing through it', () => {
    const outside = path.join(tmp, 'outside.json');
    fs.writeFileSync(outside, 'original');
    fs.mkdirSync(path.join(tmp, 'state'), { mode: 0o700 });
    const file = path.join(tmp, 'state', 'x.json');
    fs.symlinkSync(outside, file);
    writePrivateJson(file, { a: 2 });
    expect(fs.readFileSync(outside, 'utf8')).toBe('original');
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(false);
    expect(readPrivateJson(file)).toEqual({ a: 2 });
  });

  it('refuses a symlinked state directory', () => {
    const real = path.join(tmp, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const link = path.join(tmp, 'state');
    fs.symlinkSync(real, link);
    expect(() => writePrivateJson(path.join(link, 'x.json'), { a: 1 })).toThrow(InsecureStateFileError);
    expect(() => appendPrivateLine(path.join(link, 'log'), 'x')).toThrow(InsecureStateFileError);
  });

  it('tightens a pre-existing readable log to 0600 on append', () => {
    fs.mkdirSync(path.join(tmp, 'state'), { mode: 0o700 });
    const log = path.join(tmp, 'state', 'audit.jsonl');
    fs.writeFileSync(log, '', { mode: 0o644 });
    fs.chmodSync(log, 0o644);
    appendPrivateLine(log, 'x');
    expect(mode(log)).toBe(0o600);
  });

  it('appends 0600 lines and refuses a symlinked log', () => {
    const log = path.join(tmp, 'state', 'audit.jsonl');
    appendPrivateLine(log, '{"n":1}');
    appendPrivateLine(log, '{"n":2}');
    expect(mode(log)).toBe(0o600);
    expect(fs.readFileSync(log, 'utf8')).toBe('{"n":1}\n{"n":2}\n');
    const link = path.join(tmp, 'state', 'link.jsonl');
    fs.symlinkSync(log, link);
    expect(() => appendPrivateLine(link, 'x')).toThrow();
  });
});

describe('lock files', () => {
  const opts = { staleMs: 10_000, timeoutMs: 1_000 };
  const age = (file: string) => {
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(file, old, old);
  };

  it('takes over a stale lock and leaves the new holder\'s lock when the old holder releases', () => {
    const lock = path.join(tmp, 'state', 'x.lock');
    const releaseA = acquireFileLock(lock, opts);
    age(lock); // holder A looks abandoned
    const releaseB = acquireFileLock(lock, opts);
    releaseA(); // A finishes late: must not remove B's lock
    expect(fs.existsSync(lock)).toBe(true);
    expect(() => acquireFileLock(lock, { staleMs: 10_000, timeoutMs: 50 })).toThrow(/timed out/);
    releaseB();
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('does not remove a fresh lock that replaced the stale one it observed', () => {
    const lock = path.join(tmp, 'y.lock');
    fs.writeFileSync(lock, 'old');
    const observed = fs.statSync(lock);
    // Another process takes the lock over before this one acts.
    const fresh = path.join(tmp, 'y.fresh');
    fs.writeFileSync(fresh, 'new');
    fs.renameSync(fresh, lock);
    expect(removeLockIfUnchanged(lock, observed)).toBe(false);
    expect(fs.readFileSync(lock, 'utf8')).toBe('new');
    expect(fs.readdirSync(tmp).sort()).toEqual(['y.lock']);
  });

  it('removes the stale lock it observed', () => {
    const lock = path.join(tmp, 'z.lock');
    fs.writeFileSync(lock, 'old');
    expect(removeLockIfUnchanged(lock, fs.statSync(lock))).toBe(true);
    expect(fs.readdirSync(tmp)).toEqual([]);
  });
});
