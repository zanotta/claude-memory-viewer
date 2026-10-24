import { readdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parseFrontmatter } from './frontmatter.js';
import {
  analyzeMemoryIndex,
  computeIndexWindow,
  DEFAULT_INDEX_MAX_BYTES,
  DEFAULT_INDEX_MAX_LINES,
} from './memory-index.js';
import { ProjectPathResolver } from './project-path.js';
import {
  isInside,
  MAX_FILE_BYTES,
  readFixedTextFile,
  readTextFileWithin,
  type ReadResult,
} from './security.js';
import type {
  Badge,
  ConfigDirInfo,
  FileContent,
  FileEntry,
  GlobalProjectId,
  Limits,
  MemoryIndexReport,
  Overview,
  PathSource,
  ProjectDetail,
  ProjectSummary,
} from './shared/types.js';

export const GLOBAL_ID: GlobalProjectId = '@global';

/** Project-level memory files, relative to the real project folder. */
export const PROJECT_FILE_NAMES = ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md'] as const;

const MAX_MEMORY_DEPTH = 8;
const MAX_MEMORY_FILES = 5000;
const MEMORY_FILE_RE = /\.md$/i;

export function defaultLimits(): Limits {
  return {
    indexMaxLines: DEFAULT_INDEX_MAX_LINES,
    indexMaxBytes: DEFAULT_INDEX_MAX_BYTES,
    maxFileBytes: MAX_FILE_BYTES,
  };
}

export interface ScannerOptions {
  configDir: string;
  configSource?: ConfigDirInfo['source'];
  limits?: Partial<Limits>;
  resolver?: ProjectPathResolver;
}

/** A file listed for search indexing. */
export interface ListedFile {
  project: string;
  projectLabel: string;
  entry: FileEntry;
}

export type FileLookup =
  | { ok: true; content: FileContent }
  | { ok: false; status: 400 | 403 | 404 | 413 | 415; message: string };

interface RawFile {
  rel: string;
  abs: string;
  size: number;
  mtimeMs: number;
}

const BADGES = {
  notInIndex: (): Badge => ({
    id: 'not-in-index',
    label: 'not in index',
    detail: 'MEMORY.md has no link to this file.',
  }),
  brokenLink: (n: number): Badge => ({
    id: 'broken-link',
    label: 'broken link',
    detail: `${n} index ${n === 1 ? 'entry points' : 'entries point'} to a file that does not exist.`,
  }),
  beyondWindow: (detail: string): Badge => ({ id: 'beyond-window', label: 'beyond loaded window', detail }),
  pathNotFound: (p: string | null): Badge => ({
    id: 'path-not-found',
    label: 'path not found on disk',
    detail: p ? `The project folder ${p} no longer exists.` : 'The project folder no longer exists.',
  }),
  localOnly: (): Badge => ({
    id: 'local-only',
    label: 'local only',
    detail: 'Personal file (CLAUDE.local.md), not meant to be shared.',
  }),
};

function shortNameFor(id: string, realPath: string | null): string {
  if (realPath) {
    const parts = realPath.split(/[\\/]+/).filter(Boolean);
    if (parts.length) return parts.slice(-2).join('/');
  }
  return id.replace(/^-+/, '') || id;
}

function countLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (const b of buf) if (b === 0x0a) n++;
  return buf[buf.length - 1] === 0x0a ? n : n + 1;
}

export class Scanner {
  readonly configDir: string;
  readonly configSource: ConfigDirInfo['source'];
  readonly limits: Limits;
  readonly resolver: ProjectPathResolver;
  private readonly lineCache = new Map<string, { size: number; mtimeMs: number; lines: number | null }>();

  constructor(options: ScannerOptions) {
    this.configDir = options.configDir;
    this.configSource = options.configSource ?? 'default';
    this.limits = { ...defaultLimits(), ...options.limits };
    this.resolver = options.resolver ?? new ProjectPathResolver();
  }

  get projectsDir(): string {
    return path.join(this.configDir, 'projects');
  }

  // -- low level helpers ----------------------------------------------------

  private async isDir(p: string): Promise<boolean> {
    try {
      return (await stat(p)).isDirectory();
    } catch {
      return false;
    }
  }

  private async linesOf(abs: string, size: number, mtimeMs: number): Promise<number | null> {
    const cached = this.lineCache.get(abs);
    if (cached && cached.size === size && cached.mtimeMs === mtimeMs) return cached.lines;
    let lines: number | null = null;
    if (size <= this.limits.maxFileBytes) {
      try {
        lines = countLines(await readFile(abs));
      } catch {
        lines = null;
      }
    }
    if (this.lineCache.size > 5000) this.lineCache.clear();
    this.lineCache.set(abs, { size, mtimeMs, lines });
    return lines;
  }

  async listProjectIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.projectsDir, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .sort();
    } catch {
      return [];
    }
  }

  /** Lists `.md` files below the memory directory without leaving it. */
  private async scanMemoryDir(memoryDir: string, warnings: string[]): Promise<RawFile[]> {
    const out: RawFile[] = [];
    let realRoot: string;
    try {
      realRoot = await realpath(memoryDir);
    } catch {
      return out;
    }

    const walk = async (dir: string, relDir: string, depth: number): Promise<void> => {
      if (depth > MAX_MEMORY_DEPTH || out.length >= MAX_MEMORY_FILES) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        warnings.push(`Could not read folder "${relDir || 'memory'}".`);
        return;
      }
      for (const e of entries) {
        if (out.length >= MAX_MEMORY_FILES) {
          warnings.push(`Stopped listing after ${MAX_MEMORY_FILES} memory files.`);
          return;
        }
        const abs = path.join(dir, e.name);
        const rel = relDir ? `${relDir}/${e.name}` : e.name;
        if (e.isDirectory()) {
          await walk(abs, rel, depth + 1);
          continue;
        }
        if (!MEMORY_FILE_RE.test(e.name)) continue;
        if (e.isSymbolicLink()) {
          try {
            const real = await realpath(abs);
            if (!isInside(realRoot, real)) {
              warnings.push(`Skipped "${rel}": symbolic link points outside the memory folder.`);
              continue;
            }
          } catch {
            warnings.push(`Skipped "${rel}": broken symbolic link.`);
            continue;
          }
        }
        try {
          const st = await stat(abs);
          if (st.isFile()) out.push({ rel, abs, size: st.size, mtimeMs: st.mtimeMs });
        } catch {
          // vanished while scanning
        }
      }
    };
    await walk(memoryDir, '', 0);

    // MEMORY.md first, then everything else by path.
    out.sort((a, b) => {
      if (a.rel === 'MEMORY.md') return -1;
      if (b.rel === 'MEMORY.md') return 1;
      return a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0;
    });
    return out;
  }

  private async fixedEntry(
    scope: 'global' | 'project',
    virtualPath: string,
    name: string,
    abs: string,
    badges: Badge[] = [],
  ): Promise<FileEntry | null> {
    try {
      const st = await stat(abs);
      if (!st.isFile()) return null;
      return {
        scope,
        path: virtualPath,
        name,
        absPath: abs,
        size: st.size,
        lines: await this.linesOf(abs, st.size, st.mtimeMs),
        mtimeMs: st.mtimeMs,
        badges,
      };
    } catch {
      return null;
    }
  }

  // -- public scans ---------------------------------------------------------

  async configInfo(): Promise<ConfigDirInfo> {
    return {
      path: this.configDir,
      source: this.configSource,
      exists: await this.isDir(this.configDir),
      projectsDirExists: await this.isDir(this.projectsDir),
    };
  }

  async globalMemory(): Promise<Overview['global']> {
    const file = path.join(this.configDir, 'CLAUDE.md');
    const entry = await this.fixedEntry('global', 'CLAUDE.md', 'CLAUDE.md', file);
    return { path: file, exists: entry !== null, entry };
  }

  async project(id: string): Promise<ProjectDetail | null> {
    const ids = await this.listProjectIds();
    if (!ids.includes(id)) return null;
    return this.buildProject(id);
  }

  private async buildProject(id: string): Promise<ProjectDetail> {
    const dir = path.join(this.projectsDir, id);
    const warnings: string[] = [];
    const resolved = await this.resolver.resolve(dir, id);
    const realPath = resolved.path;
    const pathExists = realPath ? await this.isDir(realPath) : false;

    // Auto memory.
    const memoryDir = path.join(dir, 'memory');
    const hasMemoryDir = await this.isDir(memoryDir);
    const raw = hasMemoryDir ? await this.scanMemoryDir(memoryDir, warnings) : [];

    let indexText: string | null = null;
    const indexRaw = raw.find((f) => f.rel === 'MEMORY.md');
    if (indexRaw) {
      if (indexRaw.size > this.limits.maxFileBytes) {
        warnings.push('MEMORY.md is too large to analyse.');
      } else {
        try {
          indexText = (await readFile(indexRaw.abs, 'utf8')).replace(/^﻿/, '');
        } catch {
          warnings.push('MEMORY.md could not be read.');
        }
      }
    } else if (raw.length > 0) {
      warnings.push('The memory folder has no MEMORY.md index.');
    }

    const index: MemoryIndexReport = analyzeMemoryIndex(
      indexText,
      raw.map((f) => f.rel),
      { maxLines: this.limits.indexMaxLines, maxBytes: this.limits.indexMaxBytes },
    );
    const orphanSet = new Set(index.orphans);

    const files: FileEntry[] = [];
    for (const f of raw) {
      const badges: Badge[] = [];
      if (f.rel === 'MEMORY.md' && index.present) {
        if (index.broken.length) badges.push(BADGES.brokenLink(index.broken.length));
        const w = index.window;
        if (w && w.cutoffLine !== null) {
          badges.push(
            BADGES.beyondWindow(
              `Lines ${w.cutoffLine}–${w.totalLines} are not loaded into context ` +
                `(limit: ${w.maxLines} lines / ${Math.round(w.maxBytes / 1024)} KB).`,
            ),
          );
        }
      } else if (index.present && f.rel !== 'MEMORY.md') {
        if (orphanSet.has(f.rel)) {
          badges.push(BADGES.notInIndex());
        } else {
          const refs = index.items.filter((it) => it.status === 'ok' && it.resolved === f.rel);
          if (refs.length > 0 && refs.every((it) => it.beyondWindow)) {
            badges.push(
              BADGES.beyondWindow('Only referenced from index lines that are not loaded into context.'),
            );
          }
        }
      }
      files.push({
        scope: 'memory',
        path: `memory/${f.rel}`,
        name: f.rel,
        absPath: f.abs,
        size: f.size,
        lines: await this.linesOf(f.abs, f.size, f.mtimeMs),
        mtimeMs: f.mtimeMs,
        badges,
      });
    }
    const memoryCount = files.length;

    // Project-level files, only when the folder still exists.
    if (realPath && pathExists) {
      for (const name of PROJECT_FILE_NAMES) {
        const abs = path.join(realPath, ...name.split('/'));
        const badges = name === 'CLAUDE.local.md' ? [BADGES.localOnly()] : [];
        const entry = await this.fixedEntry('project', `project/${name}`, name, abs, badges);
        if (entry) files.push(entry);
      }
    }

    const projectFileCount = files.length - memoryCount;
    const mtimes = files.map((f) => f.mtimeMs);
    const summaryBadges: Badge[] = [];
    if (realPath && !pathExists) summaryBadges.push(BADGES.pathNotFound(realPath));

    const summary: ProjectSummary = {
      id,
      shortName: shortNameFor(id, realPath),
      realPath,
      pathSource: resolved.source satisfies PathSource,
      pathExists,
      hasMemoryDir,
      memoryFileCount: memoryCount,
      projectFileCount,
      totalSize: files.reduce((sum, f) => sum + f.size, 0),
      latestMtimeMs: mtimes.length ? Math.max(...mtimes) : null,
      badges: summaryBadges,
    };
    return { summary, files, index, warnings };
  }

  async overview(): Promise<Overview> {
    const warnings: string[] = [];
    const configDir = await this.configInfo();
    if (!configDir.exists) warnings.push(`Config directory not found: ${this.configDir}`);
    else if (!configDir.projectsDirExists) warnings.push(`No "projects" folder inside ${this.configDir}`);

    const ids = await this.listProjectIds();
    const details = await Promise.all(ids.map((id) => this.buildProject(id)));
    const projects = details.map((d) => d.summary);
    projects.sort((a, b) => {
      const am = a.latestMtimeMs ?? -1;
      const bm = b.latestMtimeMs ?? -1;
      return bm - am || (a.shortName < b.shortName ? -1 : a.shortName > b.shortName ? 1 : 0);
    });
    return {
      configDir,
      global: await this.globalMemory(),
      projects,
      warnings,
      limits: this.limits,
    };
  }

  /** Everything `--json` prints: the overview plus the detail of each project. */
  async fullReport(): Promise<{ overview: Overview; details: ProjectDetail[] }> {
    const overview = await this.overview();
    const details: ProjectDetail[] = [];
    for (const p of overview.projects) {
      const d = await this.buildProject(p.id);
      details.push(d);
    }
    return { overview, details };
  }

  /** All readable files of every project plus the global one, for search indexing. */
  async listAllFiles(): Promise<ListedFile[]> {
    const out: ListedFile[] = [];
    const global = await this.globalMemory();
    if (global.entry) out.push({ project: GLOBAL_ID, projectLabel: 'Global', entry: global.entry });
    const ids = await this.listProjectIds();
    const details = await Promise.all(ids.map((id) => this.buildProject(id)));
    for (const d of details) {
      for (const entry of d.files) {
        out.push({ project: d.summary.id, projectLabel: d.summary.shortName, entry });
      }
    }
    return out;
  }

  /** Reads the text of an entry returned by `listAllFiles()`, with the same checks as the API. */
  async readEntryText(project: string, entry: FileEntry): Promise<ReadResult> {
    if (entry.scope === 'memory') {
      return readTextFileWithin(
        path.join(this.projectsDir, project, 'memory'),
        entry.path.slice('memory/'.length),
        this.limits.maxFileBytes,
      );
    }
    return readFixedTextFile(entry.absPath, this.limits.maxFileBytes);
  }

  /**
   * `key -> "mtime:size"` for every readable file; used to detect changes by polling.
   * With `projectFilesOnly`, only the CLAUDE.md files that live in project folders
   * (the part `fs.watch` on the config directory cannot see) are stat-ed.
   */
  async snapshot(projectFilesOnly = false): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!projectFilesOnly) {
      for (const f of await this.listAllFiles()) {
        out.set(`${f.project}|${f.entry.path}`, `${f.entry.mtimeMs}:${f.entry.size}`);
      }
      return out;
    }
    for (const id of await this.listProjectIds()) {
      const resolved = await this.resolver.resolve(path.join(this.projectsDir, id), id);
      if (!resolved.path) continue;
      for (const name of PROJECT_FILE_NAMES) {
        try {
          const st = await stat(path.join(resolved.path, ...name.split('/')));
          if (st.isFile()) out.set(`${id}|project/${name}`, `${st.mtimeMs}:${st.size}`);
        } catch {
          // missing file: simply absent from the snapshot
        }
      }
    }
    return out;
  }

  // -- reading one file -----------------------------------------------------

  async readFile(projectId: string, virtualPath: string): Promise<FileLookup> {
    let result: ReadResult;
    let entryList: FileEntry[];

    if (projectId === GLOBAL_ID) {
      if (virtualPath !== 'CLAUDE.md') return { ok: false, status: 404, message: 'File not found.' };
      result = await readFixedTextFile(path.join(this.configDir, 'CLAUDE.md'), this.limits.maxFileBytes);
      const g = await this.globalMemory();
      entryList = g.entry ? [g.entry] : [];
    } else {
      const detail = await this.project(projectId);
      if (!detail) return { ok: false, status: 404, message: 'Unknown project.' };
      entryList = detail.files;
      if (virtualPath.startsWith('memory/')) {
        result = await readTextFileWithin(
          path.join(this.projectsDir, projectId, 'memory'),
          virtualPath.slice('memory/'.length),
          this.limits.maxFileBytes,
        );
      } else if (virtualPath.startsWith('project/')) {
        const name = virtualPath.slice('project/'.length);
        const allowed = (PROJECT_FILE_NAMES as readonly string[]).includes(name);
        const realPath = detail.summary.realPath;
        if (!allowed || !realPath) return { ok: false, status: 404, message: 'File not found.' };
        result = await readFixedTextFile(path.join(realPath, ...name.split('/')), this.limits.maxFileBytes);
      } else {
        return { ok: false, status: 400, message: 'Invalid path.' };
      }
    }
    if (!result.ok) return result;

    const parsed = parseFrontmatter(result.text);
    const entry =
      entryList.find((e) => e.path === virtualPath) ??
      ({
        scope: virtualPath.startsWith('memory/') ? 'memory' : virtualPath.startsWith('project/') ? 'project' : 'global',
        path: virtualPath,
        name: virtualPath.replace(/^(memory|project)\//, ''),
        absPath: result.realPath,
        size: result.size,
        lines: countLines(Buffer.from(result.text)),
        mtimeMs: result.mtimeMs,
        badges: [],
      } satisfies FileEntry);

    return {
      ok: true,
      content: {
        project: projectId,
        path: virtualPath,
        entry,
        content: result.text,
        frontmatter: parsed.entries,
        bodyStartLine: parsed.entries ? parsed.lineCount + 1 : 1,
        indexWindow:
          virtualPath === 'memory/MEMORY.md'
            ? computeIndexWindow(result.text, {
                maxLines: this.limits.indexMaxLines,
                maxBytes: this.limits.indexMaxBytes,
              })
            : null,
      },
    };
  }
}
