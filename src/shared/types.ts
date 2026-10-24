// Types shared by the server, the web UI and the tests. Types only: nothing here
// may exist at runtime, so the browser never needs to load this module.

export type BadgeId =
  | 'not-in-index'
  | 'broken-link'
  | 'beyond-window'
  | 'path-not-found'
  | 'local-only';

export interface Badge {
  id: BadgeId;
  /** Human readable label shown in the UI. */
  label: string;
  /** Optional longer explanation (tooltip). */
  detail?: string;
}

/** Where a file lives, which decides how it can be addressed through the API. */
export type FileScope = 'global' | 'memory' | 'project';

export interface FileEntry {
  scope: FileScope;
  /**
   * Virtual path used with `GET /api/file?project=...&path=...`:
   * `CLAUDE.md` (global), `memory/<rel>` or `project/<name>`.
   */
  path: string;
  /** Short name for lists (relative to its scope). */
  name: string;
  /** Absolute path on disk (display / copy only; never sent back by clients). */
  absPath: string;
  size: number;
  /** Number of lines, or null when the file is too large to be read. */
  lines: number | null;
  mtimeMs: number;
  badges: Badge[];
}

export type PathSource = 'transcript' | 'reconstructed' | 'unknown';

export interface ProjectSummary {
  /** Encoded folder name inside `<config>/projects`. Used as the API id. */
  id: string;
  /** Short label: the last path segments when known, else the encoded name. */
  shortName: string;
  realPath: string | null;
  pathSource: PathSource;
  /** False when `realPath` is known but no longer exists. */
  pathExists: boolean;
  hasMemoryDir: boolean;
  memoryFileCount: number;
  projectFileCount: number;
  totalSize: number;
  /** Most recent mtime among memory and project files, or null when there are none. */
  latestMtimeMs: number | null;
  badges: Badge[];
}

export interface GlobalMemory {
  path: string;
  exists: boolean;
  entry: FileEntry | null;
}

export interface ConfigDirInfo {
  path: string;
  source: 'flag' | 'env' | 'default';
  exists: boolean;
  projectsDirExists: boolean;
}

export interface Limits {
  /** Lines of MEMORY.md loaded into context per session. */
  indexMaxLines: number;
  /** Bytes of MEMORY.md loaded into context per session. */
  indexMaxBytes: number;
  /** Largest file the tool will open. */
  maxFileBytes: number;
}

export interface Overview {
  configDir: ConfigDirInfo;
  global: GlobalMemory;
  projects: ProjectSummary[];
  warnings: string[];
  limits: Limits;
}

export type IndexItemStatus = 'ok' | 'broken' | 'external' | 'outside' | 'other';

export interface IndexItem {
  /** 1-based line in MEMORY.md. */
  line: number;
  title: string;
  /** Link target exactly as written. */
  target: string;
  /** Path relative to the memory directory (POSIX separators), when local. */
  resolved: string | null;
  description: string;
  status: IndexItemStatus;
  /** True when the line sits beyond the window loaded into context. */
  beyondWindow: boolean;
}

export interface IndexWindow {
  maxLines: number;
  maxBytes: number;
  totalLines: number;
  totalBytes: number;
  /** First 1-based line that is NOT loaded into context, or null if everything fits. */
  cutoffLine: number | null;
}

export interface MemoryIndexReport {
  present: boolean;
  window: IndexWindow | null;
  items: IndexItem[];
  /** Index items whose file does not exist. */
  broken: IndexItem[];
  /** Memory files (relative paths) that no index item points to. */
  orphans: string[];
}

export interface ProjectDetail {
  summary: ProjectSummary;
  files: FileEntry[];
  index: MemoryIndexReport;
  warnings: string[];
}

export type FrontmatterValue = string | FrontmatterEntry[];

export interface FrontmatterEntry {
  key: string;
  value: FrontmatterValue;
}

export interface FileContent {
  project: string;
  path: string;
  entry: FileEntry;
  /** Full text, including any frontmatter. */
  content: string;
  frontmatter: FrontmatterEntry[] | null;
  /** 1-based line where the body starts (after the frontmatter block). */
  bodyStartLine: number;
  /** Present for `memory/MEMORY.md` only. */
  indexWindow: IndexWindow | null;
}

export interface SearchSegment {
  text: string;
  hit: boolean;
}

export interface SearchMatch {
  line: number;
  segments: SearchSegment[];
}

export interface SearchResult {
  project: string;
  projectLabel: string;
  path: string;
  name: string;
  matches: SearchMatch[];
  matchCount: number;
}

export interface SearchResponse {
  query: string;
  results: SearchResult[];
  /** True when more than the result limit matched. */
  truncated: boolean;
  /** Number of indexed files. */
  indexed: number;
}

export interface ChangeEvent {
  type: 'changed';
  /** `null` means "anything may have changed". */
  project: string | null;
  path: string | null;
}

export interface ApiError {
  error: string;
}

/** Reserved project id for the global memory (`<config>/CLAUDE.md`). Real ids never start with `@`. */
export type GlobalProjectId = '@global';
