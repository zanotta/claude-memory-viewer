import { open, realpath } from 'node:fs/promises';
import type { IncomingHttpHeaders } from 'node:http';
import path from 'node:path';

/** Largest file the tool opens. */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
/** Only plain-text documents are ever served. */
export const ALLOWED_EXTENSIONS: readonly string[] = ['.md', '.txt'];

// ---------------------------------------------------------------------------
// Host header (DNS rebinding) and cross-site request checks
// ---------------------------------------------------------------------------

export interface HostPolicy {
  /** Port the server is actually listening on. */
  port: number;
  /** Address the server is bound to (`--host`). */
  boundHost: string;
}

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '[::1]']);
const WILDCARDS = new Set(['0.0.0.0', '::', '[::]']);
const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
const IPV6_LITERAL_RE = /^\[[0-9a-f:.]+\]$/;

function bracket(host: string): string {
  return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}

/** True for `localhost`, 127.0.0.0/8 and `::1`. */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127(\.\d{1,3}){3}$/.test(h);
}

export function isWildcardHost(host: string): boolean {
  return WILDCARDS.has(host.trim().toLowerCase());
}

/**
 * Accepts only the Host values this server is meant to be reached with.
 * A page on another origin that rebinds its DNS name to 127.0.0.1 still sends
 * its own name in `Host`, so it is rejected here.
 */
export function isHostAllowed(hostHeader: string | undefined, policy: HostPolicy): boolean {
  if (!hostHeader || hostHeader.length > 300) return false;
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]/\\@\s]+)(?::(\d{1,5}))?$/i.exec(hostHeader.trim());
  if (!m) return false;
  const name = (m[1] ?? '').toLowerCase();
  if (m[2] === undefined || Number(m[2]) !== policy.port) return false;

  if (LOOPBACK_NAMES.has(name)) return true;
  const bound = bracket(policy.boundHost.trim().toLowerCase());
  if (isWildcardHost(bound)) {
    // Bound to every interface: a rebinding attack needs a DNS name, so IP literals are safe.
    return IPV4_RE.test(name) || IPV6_LITERAL_RE.test(name);
  }
  return name === bound;
}

/**
 * Defence in depth for API calls: browsers label every fetch with
 * `Sec-Fetch-Site`. Anything not coming from this origin (or a direct navigation)
 * is refused. Non-browser clients do not send the header and are unaffected.
 */
export function isCrossSiteRequest(headers: IncomingHttpHeaders): boolean {
  const site = headers['sec-fetch-site'];
  if (typeof site !== 'string') return false;
  return site !== 'same-origin' && site !== 'none';
}

// ---------------------------------------------------------------------------
// Path containment and safe reads
// ---------------------------------------------------------------------------

/** True when `target` is `root` itself or lives below it. Both must be absolute. */
export function isInside(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === '') return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`);
}

export function hasAllowedExtension(name: string): boolean {
  return ALLOWED_EXTENSIONS.includes(path.extname(name).toLowerCase());
}

export type ReadFailure = { ok: false; status: 400 | 403 | 404 | 413 | 415; message: string };
export type ReadSuccess = {
  ok: true;
  text: string;
  size: number;
  mtimeMs: number;
  realPath: string;
};
export type ReadResult = ReadSuccess | ReadFailure;

const fail = (status: ReadFailure['status'], message: string): ReadFailure => ({
  ok: false,
  status,
  message,
});

/** Reads an open, already validated file handle as UTF-8 text. */
async function readHandle(realPath: string, maxBytes: number): Promise<ReadResult> {
  let fh;
  try {
    fh = await open(realPath, 'r');
  } catch {
    return fail(404, 'File not found.');
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return fail(415, 'Not a regular file.');
    if (st.size > maxBytes) {
      return fail(413, `File is larger than the ${Math.round(maxBytes / 1024)} KB limit.`);
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      const { bytesRead } = await fh.read(buf, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const data = buf.subarray(0, offset);
    if (data.includes(0)) return fail(415, 'Binary content is not supported.');
    let text = data.toString('utf8');
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return { ok: true, text, size: st.size, mtimeMs: st.mtimeMs, realPath };
  } finally {
    await fh.close();
  }
}

/**
 * Reads `rel` (a `/`-separated path chosen by a client) from inside `root`.
 * The resolved real path, after following symlinks, must stay inside the real
 * root; otherwise the request is refused.
 */
export async function readTextFileWithin(
  root: string,
  rel: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<ReadResult> {
  if (!rel || rel.includes('\0')) return fail(400, 'Invalid path.');
  if (rel.includes('\\') || rel.startsWith('/') || (process.platform === 'win32' && rel.includes(':'))) {
    return fail(400, 'Invalid path.');
  }
  const segments = rel.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return fail(400, 'Invalid path.');
  if (!hasAllowedExtension(segments[segments.length - 1] ?? '')) {
    return fail(415, 'Only .md and .txt files can be opened.');
  }

  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return fail(404, 'File not found.');
  }
  const candidate = path.resolve(realRoot, ...segments);
  if (!isInside(realRoot, candidate)) return fail(403, 'Path escapes the allowed directory.');

  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    return fail(404, 'File not found.');
  }
  if (!isInside(realRoot, real)) return fail(403, 'Path escapes the allowed directory.');
  return readHandle(real, maxBytes);
}

/**
 * Reads one of the fixed, server-chosen file names (global or project
 * `CLAUDE.md`). No client input reaches `absPath`. Unlike memory files, these
 * may be symlinks to somewhere else (a shared dotfiles repository is common).
 */
export async function readFixedTextFile(
  absPath: string,
  maxBytes: number = MAX_FILE_BYTES,
): Promise<ReadResult> {
  if (!hasAllowedExtension(absPath)) return fail(415, 'Only .md and .txt files can be opened.');
  let real: string;
  try {
    real = await realpath(absPath);
  } catch {
    return fail(404, 'File not found.');
  }
  return readHandle(real, maxBytes);
}
