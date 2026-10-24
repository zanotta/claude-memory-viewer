import type { Scanner } from './scanner.js';
import type { SearchMatch, SearchResponse, SearchResult, SearchSegment } from './shared/types.js';

export const MAX_RESULTS = 200;
const MAX_TERMS = 8;
const SNIPPETS_PER_FILE = 3;
const SNIPPET_WINDOW_BEFORE = 60;
const SNIPPET_WINDOW_AFTER = 140;
const STALE_AFTER_MS = 3000;

interface Normalized {
  /** Lower-cased text without diacritics. */
  norm: string;
  /** For each unit of `norm`, the range it came from in the original string. */
  starts: number[];
  ends: number[];
}

/**
 * Case and accent insensitive form of `text`: NFD, combining marks removed,
 * lower-cased. Works code point by code point so positions can be mapped back.
 */
export function normalizeWithMap(text: string): Normalized {
  let norm = '';
  const starts: number[] = [];
  const ends: number[] = [];
  let i = 0;
  for (const ch of text) {
    const start = i;
    const end = i + ch.length;
    i = end;
    const piece = ch.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
    if (piece === '') {
      // A bare combining mark: attach it to the previous character's range.
      if (ends.length > 0) ends[ends.length - 1] = end;
      continue;
    }
    norm += piece;
    for (let k = 0; k < piece.length; k++) {
      starts.push(start);
      ends.push(end);
    }
  }
  return { norm, starts, ends };
}

export function normalizeText(text: string): string {
  return normalizeWithMap(text).norm;
}

interface Doc {
  project: string;
  projectLabel: string;
  path: string;
  name: string;
  signature: string;
  text: string;
  norm: string;
}

interface Range {
  from: number;
  to: number;
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.from - b.from || a.to - b.to);
  const out: Range[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) last.to = Math.max(last.to, r.to);
    else out.push({ ...r });
  }
  return out;
}

/** Builds highlight segments for one line; the text is never turned into HTML. */
export function highlightLine(line: string, terms: readonly string[]): SearchSegment[] {
  const n = normalizeWithMap(line);
  const found: Range[] = [];
  for (const term of terms) {
    let at = n.norm.indexOf(term);
    while (at >= 0) {
      const from = n.starts[at];
      const to = n.ends[at + term.length - 1];
      if (from !== undefined && to !== undefined) found.push({ from, to });
      at = n.norm.indexOf(term, at + term.length);
    }
  }
  const ranges = mergeRanges(found);
  if (ranges.length === 0) return [{ text: line.length > 200 ? `${line.slice(0, 200)}…` : line, hit: false }];

  // Window around the first hit for very long lines.
  let from = 0;
  let to = line.length;
  const first = ranges[0] as Range;
  if (line.length > SNIPPET_WINDOW_BEFORE + SNIPPET_WINDOW_AFTER) {
    from = Math.max(0, first.from - SNIPPET_WINDOW_BEFORE);
    to = Math.min(line.length, first.to + SNIPPET_WINDOW_AFTER);
  }
  const segments: SearchSegment[] = [];
  if (from > 0) segments.push({ text: '…', hit: false });
  let cursor = from;
  for (const r of ranges) {
    if (r.to <= from || r.from >= to) continue;
    const a = Math.max(r.from, from);
    const b = Math.min(r.to, to);
    if (a > cursor) segments.push({ text: line.slice(cursor, a), hit: false });
    segments.push({ text: line.slice(a, b), hit: true });
    cursor = b;
  }
  if (cursor < to) segments.push({ text: line.slice(cursor, to), hit: false });
  if (to < line.length) segments.push({ text: '…', hit: false });
  return segments;
}

export interface RefreshStats {
  added: number;
  updated: number;
  removed: number;
  total: number;
}

export class SearchIndex {
  private readonly docs = new Map<string, Doc>();
  private lastRefresh = 0;
  private running: Promise<RefreshStats> | null = null;
  private queued = false;
  private first: Promise<RefreshStats> | null = null;

  constructor(private readonly scanner: Scanner) {}

  get size(): number {
    return this.docs.size;
  }

  /** Re-reads only files whose mtime/size changed; drops files that disappeared. */
  refresh(): Promise<RefreshStats> {
    if (this.running) {
      this.queued = true;
      return this.running;
    }
    const run = this.doRefresh().finally(() => {
      this.running = null;
      if (this.queued) {
        this.queued = false;
        void this.refresh();
      }
    });
    this.running = run;
    this.first ??= run;
    return run;
  }

  private async doRefresh(): Promise<RefreshStats> {
    const stats: RefreshStats = { added: 0, updated: 0, removed: 0, total: 0 };
    const listed = await this.scanner.listAllFiles();
    const seen = new Set<string>();
    const limit = this.scanner.limits.maxFileBytes;

    for (const { project, projectLabel, entry } of listed) {
      if (entry.size > limit) continue;
      const key = `${project}\u0000${entry.path}`;
      const signature = `${entry.absPath}|${entry.mtimeMs}|${entry.size}`;
      seen.add(key);
      const existing = this.docs.get(key);
      if (existing && existing.signature === signature) {
        existing.projectLabel = projectLabel;
        continue;
      }
      const read = await this.scanner.readEntryText(project, entry);
      if (!read.ok) {
        seen.delete(key);
        continue;
      }
      this.docs.set(key, {
        project,
        projectLabel,
        path: entry.path,
        name: entry.name,
        signature,
        text: read.text,
        norm: normalizeText(read.text),
      });
      if (existing) stats.updated++;
      else stats.added++;
    }
    for (const key of [...this.docs.keys()]) {
      if (!seen.has(key)) {
        this.docs.delete(key);
        stats.removed++;
      }
    }
    stats.total = this.docs.size;
    this.lastRefresh = Date.now();
    return stats;
  }

  async search(query: string): Promise<SearchResponse> {
    await (this.first ?? this.refresh()).catch(() => undefined);
    if (Date.now() - this.lastRefresh > STALE_AFTER_MS) await this.refresh().catch(() => undefined);

    const terms = [
      ...new Set(
        normalizeText(query)
          .split(/\s+/)
          .filter((t) => t.length > 0),
      ),
    ].slice(0, MAX_TERMS);
    const base: SearchResponse = { query: query.trim(), results: [], truncated: false, indexed: this.docs.size };
    if (terms.length === 0) return base;

    const scored: { score: number; result: SearchResult }[] = [];
    for (const doc of this.docs.values()) {
      // A term may be found in the file name or in the text; every term must be found somewhere.
      const nameNorm = normalizeText(doc.name);
      if (!terms.every((t) => doc.norm.includes(t) || nameNorm.includes(t))) continue;
      const lines = doc.text.split('\n');
      const normLines = doc.norm.split('\n');
      const matches: SearchMatch[] = [];
      let matchCount = 0;
      for (let i = 0; i < normLines.length; i++) {
        const nl = normLines[i] ?? '';
        if (!terms.some((t) => nl.includes(t))) continue;
        matchCount++;
        if (matches.length < SNIPPETS_PER_FILE) {
          matches.push({ line: i + 1, segments: highlightLine((lines[i] ?? '').replace(/\r$/, ''), terms) });
        }
      }
      const score = matchCount + (terms.some((t) => nameNorm.includes(t)) ? 1000 : 0);
      scored.push({
        score,
        result: {
          project: doc.project,
          projectLabel: doc.projectLabel,
          path: doc.path,
          name: doc.name,
          matches,
          matchCount,
        },
      });
    }
    scored.sort(
      (a, b) =>
        b.score - a.score ||
        (a.result.projectLabel < b.result.projectLabel ? -1 : a.result.projectLabel > b.result.projectLabel ? 1 : 0) ||
        (a.result.path < b.result.path ? -1 : a.result.path > b.result.path ? 1 : 0),
    );
    return {
      ...base,
      results: scored.slice(0, MAX_RESULTS).map((s) => s.result),
      truncated: scored.length > MAX_RESULTS,
    };
  }
}
