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
 * Move `lockPath` aside if it is still the file `observed` describes (same
 * device and inode); true if it was removed. A different file found there is
 * put back.
 */
export function removeLockIfUnchanged(lockPath: string, observed: fs.Stats): boolean {
  const aside = `${lockPath}.${process.pid}.${randomBytes(6).toString('hex')}.old`;
  try {
    fs.renameSync(lockPath, aside);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  let moved: fs.Stats | undefined;
  try {
    moved = fs.lstatSync(aside);
  } catch {
    moved = undefined;
  }
  if (moved && (moved.ino !== observed.ino || moved.dev !== observed.dev)) {
    // Another process replaced the file in the meantime: put its lock back.
    try {
      fs.linkSync(aside, lockPath);
    } catch {
      // A third process took the path; its lock stands.
    }
    fs.rmSync(aside, { force: true });
    return false;
  }
  fs.rmSync(aside, { force: true });
  return true;
}

/**
 * Take an exclusive lock file (O_EXCL, 0600). A lock older than `staleMs` is
 * taken over by renaming it aside and checking that the file moved is the one
 * found stale, so two processes cannot both remove a lock and a fresh lock is
 * never removed as stale. Release removes the lock only while it is still this
 * process's file. Returns the release function.
 */
export function acquireFileLock(lockPath: string, opts: FileLockOptions): () => void {
  const deadline = Date.now() + opts.timeoutMs;
  ensurePrivateDir(path.dirname(lockPath));
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, FILE_MODE);
      let mine: fs.Stats;
      try {
        fs.writeSync(fd, String(process.pid));
        mine = fs.fstatSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      return () => {
        removeLockIfUnchanged(lockPath, mine);
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      let current: fs.Stats;
      try {
        current = fs.lstatSync(lockPath);
      } catch {
        continue;
      }
      if (Date.now() - current.mtimeMs > opts.staleMs) {
        removeLockIfUnchanged(lockPath, current);
        continue;
      }
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${lockPath}`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
