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
  const st = fs.statSync(dir);
  if (!st.isDirectory()) {
    throw new InsecureStateFileError(`${dir} exists and is not a directory`);
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
  assertNotWritableByOthers(path.dirname(filePath), fs.statSync(path.dirname(filePath)));
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
    fs.writeSync(fd, line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    fs.closeSync(fd);
  }
}
