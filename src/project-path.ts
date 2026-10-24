import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { PathSource } from './shared/types.js';

/**
 * Claude Code names each project folder after the project path with every
 * character outside `[A-Za-z0-9]` replaced by `-`. That makes the name lossy:
 * `/a/b-c`, `/a/b/c` and `/a/b.c` all encode to `-a-b-c`.
 */
export function encodeProjectPath(projectPath: string): string {
  return projectPath.replace(/[^a-zA-Z0-9]/g, '-');
}

/** Names longer than this are reported to be truncated (plus a hash) by some versions. */
const LONG_NAME_THRESHOLD = 200;

/** True when `candidate` is a plausible origin of the folder name `encodedName`. */
export function encodedMatches(candidate: string, encodedName: string): boolean {
  const enc = encodeProjectPath(candidate);
  if (enc === encodedName) return true;
  return (
    encodedName.length > LONG_NAME_THRESHOLD &&
    enc.length > LONG_NAME_THRESHOLD &&
    enc.slice(0, LONG_NAME_THRESHOLD) === encodedName.slice(0, LONG_NAME_THRESHOLD)
  );
}

// ---------------------------------------------------------------------------
// Strategy 1: the `cwd` field of the first records of a transcript.
// ---------------------------------------------------------------------------

export interface TranscriptReadOptions {
  /** Hard cap on bytes read from a single file. */
  maxBytes?: number;
  /** Hard cap on lines examined per file. */
  maxLines?: number;
  /** How many of the most recent transcripts to try. */
  maxFiles?: number;
}

const CHUNK = 64 * 1024;

async function cwdFromFile(
  file: string,
  encodedName: string,
  maxBytes: number,
  maxLines: number,
): Promise<string | null> {
  const fh = await open(file, 'r');
  try {
    const chunk = Buffer.alloc(CHUNK);
    let pending: Buffer = Buffer.alloc(0);
    let totalRead = 0;
    let lines = 0;
    for (;;) {
      const wanted = Math.min(CHUNK, maxBytes - totalRead);
      const { bytesRead } = wanted > 0 ? await fh.read(chunk, 0, wanted, null) : { bytesRead: 0 };
      const eof = bytesRead === 0;
      if (!eof) {
        totalRead += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0, bytesRead)]);
      }
      for (;;) {
        const nl = pending.indexOf(0x0a);
        let line: Buffer;
        if (nl >= 0) {
          line = pending.subarray(0, nl);
          pending = pending.subarray(nl + 1);
        } else if (eof && pending.length > 0) {
          line = pending; // final line without trailing newline
          pending = Buffer.alloc(0);
        } else {
          break;
        }
        lines++;
        if (line.includes('"cwd"')) {
          try {
            const record: unknown = JSON.parse(line.toString('utf8'));
            const cwd = (record as { cwd?: unknown }).cwd;
            if (typeof cwd === 'string' && cwd && encodedMatches(cwd, encodedName)) return cwd;
          } catch {
            // malformed or truncated line: ignore
          }
        }
        if (lines >= maxLines) return null;
      }
      // A partial line left in `pending` when the cap is hit is dropped on purpose.
      if (eof || totalRead >= maxBytes) return null;
    }
  } finally {
    await fh.close();
  }
}

/**
 * Looks for a `cwd` that re-encodes to `encodedName` in the first bytes of the
 * most recently modified transcripts. Never reads a transcript in full.
 */
export async function readCwdFromTranscripts(
  projectDir: string,
  encodedName: string,
  options: TranscriptReadOptions = {},
): Promise<string | null> {
  const maxBytes = options.maxBytes ?? 1024 * 1024;
  const maxLines = options.maxLines ?? 400;
  const maxFiles = options.maxFiles ?? 5;

  let names: string[];
  try {
    names = (await readdir(projectDir)).filter((n) => n.endsWith('.jsonl'));
  } catch {
    return null;
  }
  const withTimes: { file: string; mtimeMs: number }[] = [];
  for (const n of names) {
    const file = path.join(projectDir, n);
    try {
      const st = await stat(file);
      if (st.isFile()) withTimes.push({ file, mtimeMs: st.mtimeMs });
    } catch {
      // vanished while listing
    }
  }
  withTimes.sort((a, b) => b.mtimeMs - a.mtimeMs);

  for (const { file } of withTimes.slice(0, maxFiles)) {
    try {
      const cwd = await cwdFromFile(file, encodedName, maxBytes, maxLines);
      if (cwd) return cwd;
    } catch {
      // unreadable transcript: try the next one
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Strategy 2: rebuild the path by walking the real filesystem.
// ---------------------------------------------------------------------------

export interface DirEntryInfo {
  name: string;
  isDirectory: boolean;
}

/** Minimal filesystem surface so the search can be tested with an in-memory tree. */
export interface FsProbe {
  /** Entries of `dir`, or null when it cannot be read. */
  readdir(dir: string): Promise<DirEntryInfo[] | null>;
}

export const realFsProbe: FsProbe = {
  async readdir(dir) {
    try {
      const entries = await readdir(dir, { withFileTypes: true });
      const out: DirEntryInfo[] = [];
      for (const e of entries) {
        let isDirectory = e.isDirectory();
        if (!isDirectory && e.isSymbolicLink()) {
          try {
            isDirectory = (await stat(path.join(dir, e.name))).isDirectory();
          } catch {
            isDirectory = false;
          }
        }
        out.push({ name: e.name, isDirectory });
      }
      return out;
    } catch {
      return null;
    }
  },
};

export interface ReconstructOptions {
  platform?: 'posix' | 'win32';
  fs?: FsProbe;
  /** Upper bound on directory reads, which bounds the whole search. */
  maxReaddirs?: number;
}

export interface Reconstruction {
  path: string;
  /** True when more than one real directory encodes to the same name. */
  ambiguous: boolean;
}

/**
 * Finds the real directory whose encoding is `encodedName`. Instead of guessing
 * which `-` was a separator, it lists each directory on the way and keeps the
 * entries whose own encoding is a prefix of what is left of the name.
 */
export async function reconstructProjectPath(
  encodedName: string,
  options: ReconstructOptions = {},
): Promise<Reconstruction | null> {
  const platform = options.platform ?? (process.platform === 'win32' ? 'win32' : 'posix');
  const fsProbe = options.fs ?? realFsProbe;
  const maxReaddirs = options.maxReaddirs ?? 400;
  const p = platform === 'win32' ? path.win32 : path.posix;

  let root: string;
  let rest: string;
  if (platform === 'win32') {
    // `C:\Users\ana` encodes to `C--Users-ana`: drive letter, then ':' and '\' → '-'.
    const m = /^([A-Za-z])-(-.*)?$/.exec(encodedName);
    if (!m) return null;
    root = `${m[1]}:\\`;
    rest = m[2] ?? '';
  } else {
    if (!encodedName.startsWith('-')) return null;
    root = '/';
    rest = encodedName;
  }

  let readdirs = 0;
  const cache = new Map<string, DirEntryInfo[] | null>();
  const list = async (dir: string): Promise<DirEntryInfo[] | null> => {
    if (cache.has(dir)) return cache.get(dir) ?? null;
    if (readdirs >= maxReaddirs) return null;
    readdirs++;
    const entries = await fsProbe.readdir(dir);
    cache.set(dir, entries);
    return entries;
  };

  const found: string[] = [];
  const dfs = async (dir: string, remaining: string): Promise<void> => {
    if (found.length > 1) return;
    if (remaining === '') {
      found.push(dir);
      return;
    }
    if (!remaining.startsWith('-')) return;
    const entries = await list(dir);
    if (!entries) return;
    const candidates = entries
      .filter((e) => e.isDirectory)
      .map((e) => ({ entry: e, enc: encodeProjectPath(e.name) }))
      .filter(({ enc }) => {
        const wanted = `-${enc}`;
        return (
          remaining.startsWith(wanted) &&
          (remaining.length === wanted.length || remaining[wanted.length] === '-')
        );
      })
      // Longest segment first, then alphabetical, so results are deterministic.
      .sort((a, b) => b.enc.length - a.enc.length || (a.entry.name < b.entry.name ? -1 : 1));
    for (const { entry, enc } of candidates) {
      await dfs(p.join(dir, entry.name), remaining.slice(1 + enc.length));
      if (found.length > 1) return;
    }
  };

  await dfs(root, rest);
  const first = found[0];
  return first === undefined ? null : { path: first, ambiguous: found.length > 1 };
}

// ---------------------------------------------------------------------------
// Combined, cached resolver.
// ---------------------------------------------------------------------------

export interface ResolvedProjectPath {
  path: string | null;
  source: PathSource;
}

interface CacheEntry {
  value: ResolvedProjectPath;
  at: number;
}

export interface ResolverOptions {
  transcript?: TranscriptReadOptions;
  reconstruct?: ReconstructOptions;
  /** How long an "unknown" result is remembered, in ms. */
  negativeTtlMs?: number;
}

export class ProjectPathResolver {
  private readonly cache = new Map<string, CacheEntry>();

  constructor(private readonly options: ResolverOptions = {}) {}

  async resolve(projectDir: string, encodedName: string): Promise<ResolvedProjectPath> {
    const hit = this.cache.get(encodedName);
    const ttl = this.options.negativeTtlMs ?? 5000;
    if (hit && (hit.value.path !== null || Date.now() - hit.at < ttl)) return hit.value;

    let value: ResolvedProjectPath = { path: null, source: 'unknown' };
    const fromTranscript = await readCwdFromTranscripts(projectDir, encodedName, this.options.transcript);
    if (fromTranscript) {
      value = { path: fromTranscript, source: 'transcript' };
    } else {
      const rebuilt = await reconstructProjectPath(encodedName, this.options.reconstruct);
      if (rebuilt) value = { path: rebuilt.path, source: 'reconstructed' };
    }
    this.cache.set(encodedName, { value, at: Date.now() });
    return value;
  }

  clear(): void {
    this.cache.clear();
  }
}
