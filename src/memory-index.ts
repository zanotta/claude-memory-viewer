import path from 'node:path';
import type {
  IndexItem,
  IndexItemStatus,
  IndexWindow,
  MemoryIndexReport,
} from './shared/types.js';

/** Documented window of MEMORY.md that is loaded into context each session. */
export const DEFAULT_INDEX_MAX_LINES = 200;
export const DEFAULT_INDEX_MAX_BYTES = 25 * 1024;

export interface IndexLimits {
  maxLines: number;
  maxBytes: number;
}

const DEFAULT_LIMITS: IndexLimits = {
  maxLines: DEFAULT_INDEX_MAX_LINES,
  maxBytes: DEFAULT_INDEX_MAX_BYTES,
};

// "- [Title](target.md) — description", tolerant of "*"/"+" bullets, titles in
// the URL part, and any (or no) dash character before the description.
const ITEM_RE = /^\s*[-*+]\s+\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)\s*(.*)$/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

/** Computes which part of the text fits in the loaded window. */
export function computeIndexWindow(text: string, limits: IndexLimits = DEFAULT_LIMITS): IndexWindow {
  const lines = text.split('\n');
  // A trailing newline produces an empty final element that is not a real line.
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  let bytes = 0;
  let cutoffLine: number | null = null;
  for (let i = 0; i < lines.length; i++) {
    const lineBytes = Buffer.byteLength(lines[i] ?? '', 'utf8') + 1; // + newline
    if (i >= limits.maxLines || bytes + lineBytes > limits.maxBytes) {
      cutoffLine = i + 1;
      break;
    }
    bytes += lineBytes;
  }
  return {
    maxLines: limits.maxLines,
    maxBytes: limits.maxBytes,
    totalLines: lines.length,
    totalBytes: Buffer.byteLength(text, 'utf8'),
    cutoffLine,
  };
}

function stripDescriptionDash(rest: string): string {
  return rest.replace(/^[\s—–:-]+/u, '').trim();
}

function resolveTarget(target: string): { resolved: string | null; status: IndexItemStatus } {
  let t = target;
  try {
    t = decodeURIComponent(t);
  } catch {
    // keep as written
  }
  if (SCHEME_RE.test(t) || t.startsWith('//')) return { resolved: null, status: 'external' };
  t = t.replace(/[?#].*$/, '').replace(/\\/g, '/');
  if (!t) return { resolved: null, status: 'other' }; // pure anchor
  const normalized = path.posix.normalize(t);
  if (normalized.startsWith('..') || path.posix.isAbsolute(normalized)) {
    return { resolved: null, status: 'outside' };
  }
  const clean = normalized.replace(/^\.\//, '');
  if (!/\.(md|markdown)$/i.test(clean)) return { resolved: clean, status: 'other' };
  return { resolved: clean, status: 'ok' };
}

/**
 * Parses the link items of a MEMORY.md and checks them against the files that
 * actually exist in the memory directory (`memoryFiles`: POSIX relative paths).
 */
export function analyzeMemoryIndex(
  text: string | null,
  memoryFiles: readonly string[],
  limits: IndexLimits = DEFAULT_LIMITS,
  indexName = 'MEMORY.md',
): MemoryIndexReport {
  if (text === null) {
    return { present: false, window: null, items: [], broken: [], orphans: [] };
  }
  const window = computeIndexWindow(text, limits);
  const known = new Set(memoryFiles);
  const items: IndexItem[] = [];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = ITEM_RE.exec(lines[i] ?? '');
    if (!m) continue;
    const target = m[2] ?? '';
    const { resolved, status: initial } = resolveTarget(target);
    let status = initial;
    if (status === 'ok' && resolved !== null && !known.has(resolved)) status = 'broken';
    items.push({
      line: i + 1,
      title: (m[1] ?? '').trim(),
      target,
      resolved,
      description: stripDescriptionDash(m[3] ?? ''),
      status,
      beyondWindow: window.cutoffLine !== null && i + 1 >= window.cutoffLine,
    });
  }

  const referenced = new Set(
    items.filter((it) => it.status === 'ok' && it.resolved !== null).map((it) => it.resolved as string),
  );
  const orphans = memoryFiles
    .filter((f) => f !== indexName && /\.(md|markdown)$/i.test(f) && !referenced.has(f))
    .slice()
    .sort();

  return {
    present: true,
    window,
    items,
    broken: items.filter((it) => it.status === 'broken'),
    orphans,
  };
}
