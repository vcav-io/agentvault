/**
 * Private state files under $SELKEY_WORKDIR/.selkey.
 *
 * - Directories are created (or tightened) to 0700.
 * - Files are written 0600 through an O_EXCL temp file and an atomic rename,
 *   so a pre-existing file or symlink at the temp path is never followed.
 * - Files that are group- or world-writable (or whose directory is) are
 *   refused on load, because another local user could have edited them.
 *
 * POSIX permission checks are skipped on Windows, where modes are not
 * meaningful.
 */

import { randomBytes } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const IS_POSIX = process.platform !== 'win32';

export class InsecureStateFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InsecureStateFileError';
  }
}

/** Resolve $SELKEY_WORKDIR/.selkey (falls back to the process cwd). */
export function selkeyStateDir(): string {
  const workdir = process.env['SELKEY_WORKDIR'] ?? process.cwd();
  return path.join(workdir, '.selkey');
}

/**
 * Create `dir` (and missing parents) with mode 0700. If it already exists
 * with group/other permission bits set, tighten it to 0700.
 */
export function ensurePrivateDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  if (!IS_POSIX) return;
  const st = fs.lstatSync(dir);
  if (st.isSymbolicLink() || !st.isDirectory()) {
    throw new InsecureStateFileError(`refusing to use ${dir}: not a directory (or a symlink)`);
  }
  if ((st.mode & 0o077) !== 0) {
    fs.chmodSync(dir, DIR_MODE);
  }
}

function assertNotWritableByOthers(target: string, st: fs.Stats): void {
  if (!IS_POSIX) return;
  if ((st.mode & 0o022) !== 0) {
    throw new InsecureStateFileError(
      `refusing to use ${target}: it is group- or world-writable (mode ${(st.mode & 0o777).toString(8)})`,
    );
  }
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid && st.uid !== 0) {
    throw new InsecureStateFileError(`refusing to use ${target}: it is owned by another user`);
  }
}

/**
 * Write `data` as JSON to `filePath` with mode 0600, atomically. The parent
 * directory is created with mode 0700.
 */
export function writePrivateJson(filePath: string, data: unknown): void {
  writePrivateFile(filePath, JSON.stringify(data, null, 2) + '\n');
}

export function writePrivateFile(filePath: string, contents: string): void {
  const dir = path.dirname(filePath);
  ensurePrivateDir(dir);
  const tmpPath = `${filePath}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const fd = fs.openSync(
    tmpPath,
    fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL,
    FILE_MODE,
  );
  try {
    fs.writeFileSync(fd, contents, 'utf8');
    fs.fsyncSync(fd);
  } catch (err) {
    fs.closeSync(fd);
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort
    }
    throw err;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // best effort
    }
    throw err;
  }
}

/**
 * Read a private JSON state file. Returns `undefined` if it does not exist.
 * Throws InsecureStateFileError if the file or its directory is group- or
 * world-writable, or if the file is a symlink.
 */
export function readPrivateJson(filePath: string): unknown {
  let st: fs.Stats;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  if (st.isSymbolicLink() || !st.isFile()) {
    throw new InsecureStateFileError(`refusing to use ${filePath}: not a regular file`);
  }
  assertNotWritableByOthers(filePath, st);
  const dirSt = fs.lstatSync(path.dirname(filePath));
  if (dirSt.isSymbolicLink() || !dirSt.isDirectory()) {
    throw new InsecureStateFileError(`refusing to use ${path.dirname(filePath)}: not a directory (or a symlink)`);
  }
  assertNotWritableByOthers(path.dirname(filePath), dirSt);
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

/**
 * Append one line to a private, append-only log file (mode 0600, created on
 * first use). Refuses symlinks and files writable by others.
 */
export function appendPrivateLine(filePath: string, line: string): void {
  ensurePrivateDir(path.dirname(filePath));
  const flags =
    fs.constants.O_WRONLY |
    fs.constants.O_CREAT |
    fs.constants.O_APPEND |
    (IS_POSIX ? fs.constants.O_NOFOLLOW : 0);
  const fd = fs.openSync(filePath, flags, FILE_MODE);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) {
      throw new InsecureStateFileError(`refusing to use ${filePath}: not a regular file`);
    }
    assertNotWritableByOthers(filePath, st);
    // Tighten a pre-existing file that others can read (e.g. 0644 -> 0600).
    if (IS_POSIX && (st.mode & 0o077) !== 0) fs.fchmodSync(fd, FILE_MODE);
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
}

// ── Lock files ────────────────────────────────────────────────────────────

export interface FileLockOptions {
  /** A lock whose mtime is older than this is treated as abandoned. */
  staleMs: number;
  /** Give up after this long. */
  timeoutMs: number;
}

/**
 * Run `fn` while holding `<lockPath>.takeover`, an O_EXCL marker that every
 * removal of `lockPath` (stale takeover and release) holds. While it is held
 * no other process can remove the lock file, so the file read inside `fn` is
 * the file `fn` removes. Returns undefined if the marker could not be taken
 * in time. A marker older than `staleMs` (its holder died inside the short
 * critical section) is removed.
 */
function withRemovalMarker<T>(lockPath: string, opts: FileLockOptions, fn: () => T): T | undefined {
  const marker = `${lockPath}.takeover`;
  const deadline = Date.now() + opts.timeoutMs;
  for (;;) {
    let fd: number;
    try {
      fd = fs.openSync(marker, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      try {
        if (Date.now() - fs.lstatSync(marker).mtimeMs > opts.staleMs) fs.rmSync(marker, { force: true });
      } catch {
        // gone already
      }
      if (Date.now() > deadline) return undefined;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      continue;
    }
    fs.closeSync(fd);
    try {
      return fn();
    } finally {
      fs.rmSync(marker, { force: true });
    }
  }
}

/** mtime and contents of the lock file, read from one open file descriptor. */
function readLock(lockPath: string): { mtimeMs: number; token: string } | undefined {
  let fd: number;
  try {
    fd = fs.openSync(lockPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw err;
  }
  try {
    const { mtimeMs } = fs.fstatSync(fd);
    return { mtimeMs, token: fs.readFileSync(fd, 'utf8') };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Remove `lockPath` if it still holds `expected` (every lock holds a unique
 * token, so inode reuse cannot make a new lock look like the old one). The
 * check and the removal happen under the removal marker. True if removed.
 */
export function removeLockIfUnchanged(
  lockPath: string,
  expected: string,
  opts: FileLockOptions = { staleMs: 10_000, timeoutMs: 5_000 },
): boolean {
  return (
    withRemovalMarker(lockPath, opts, () => {
      const current = readLock(lockPath);
      if (!current || current.token !== expected) return false;
      fs.unlinkSync(lockPath);
      return true;
    }) ?? false
  );
}

/**
 * Take an exclusive lock file (O_EXCL, 0600) holding a unique token.
 *
 * A lock whose mtime is older than `staleMs` is taken over under the removal
 * marker: its mtime and token are read from one file descriptor, and it is
 * removed only if still stale, so a lock created by a concurrent takeover is
 * never removed. Release removes the lock only while it still holds this
 * holder's token (also under the marker). If the marker cannot be taken in
 * time, release leaves the lock to go stale; that affects liveness only.
 * Returns the release function.
 */
export function acquireFileLock(lockPath: string, opts: FileLockOptions): () => void {
  const deadline = Date.now() + opts.timeoutMs;
  ensurePrivateDir(path.dirname(lockPath));
  const token = `${process.pid}:${randomBytes(16).toString('hex')}`;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
      try {
        fs.writeSync(fd, token);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        removeLockIfUnchanged(lockPath, token, opts);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      const remaining = Math.max(0, deadline - Date.now());
      const tookOver = withRemovalMarker(lockPath, { staleMs: opts.staleMs, timeoutMs: remaining }, () => {
        const current = readLock(lockPath);
        if (!current) return true;
        if (Date.now() - current.mtimeMs <= opts.staleMs) return false;
        fs.unlinkSync(lockPath);
        return true;
      });
      if (tookOver) continue;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
