import type {
  Badge,
  FileContent,
  FileEntry,
  FrontmatterEntry,
  IndexWindow,
  Overview,
  ProjectDetail,
  ProjectSummary,
  SearchResponse,
} from '../shared/types.js';
import { api } from './api.js';
import { append, clear, copyText, h, type Child } from './dom.js';
import { absoluteTime, formatBytes, plural, relativeTime, resolveRelative } from './format.js';
import { renderMarkdown } from './markdown.js';

const GLOBAL_ID = '@global';

type Route =
  | { kind: 'home' }
  | { kind: 'global' }
  | { kind: 'project'; id: string; path: string | null }
  | { kind: 'search'; q: string };

type Pane = 'projects' | 'files' | 'content';

interface State {
  overview: Overview | null;
  detail: ProjectDetail | null;
  file: FileContent | null;
  search: SearchResponse | null;
  route: Route;
  raw: boolean;
  error: string | null;
  pane: Pane;
  returnHash: string;
}

const state: State = {
  overview: null,
  detail: null,
  file: null,
  search: null,
  route: { kind: 'home' },
  raw: false,
  error: null,
  pane: 'projects',
  returnHash: '#/',
};

function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el;
}

const layoutEl = byId('layout');
const projectsEl = byId('projects');
const filesEl = byId('files');
const contentEl = byId('content');
const searchInput = byId('search-input') as HTMLInputElement;
const searchForm = byId('search-form');
const liveEl = byId('live');
const toastEl = byId('toast');

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const enc = encodeURIComponent;

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function parseHash(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  switch (parts[0]) {
    case 'global':
      return { kind: 'global' };
    case 'p': {
      const id = parts[1] ? safeDecode(parts[1]) : '';
      if (!id) return { kind: 'home' };
      return { kind: 'project', id, path: parts[2] ? safeDecode(parts[2]) : null };
    }
    case 'search':
      return { kind: 'search', q: parts[1] ? safeDecode(parts[1]) : '' };
    default:
      return { kind: 'home' };
  }
}

function fileHash(projectId: string, path: string | null): string {
  if (projectId === GLOBAL_ID) return '#/global';
  return `#/p/${enc(projectId)}${path ? `/${enc(path)}` : ''}`;
}

let navSeq = 0;

function defaultFile(detail: ProjectDetail): FileEntry | null {
  return (
    detail.files.find((f) => f.path === 'memory/MEMORY.md') ??
    detail.files.find((f) => f.scope === 'memory') ??
    detail.files[0] ??
    null
  );
}

/** Loads whatever the current route needs. `force` refetches even when already loaded. */
async function load(route: Route, force: boolean): Promise<void> {
  const seq = ++navSeq;
  let error: string | null = null;
  try {
    const overview = await api.overview();
    if (seq !== navSeq) return;
    state.overview = overview;

    if (route.kind === 'project') {
      let detail = state.detail;
      if (force || detail?.summary.id !== route.id) {
        detail = await api.project(route.id);
        if (seq !== navSeq) return;
        state.detail = detail;
      }
      const wanted = route.path ?? (detail ? defaultFile(detail)?.path : null) ?? null;
      if (wanted && detail) {
        const stale = state.file?.project !== route.id || state.file?.path !== wanted;
        if (force || stale) {
          const file = await api.file(route.id, wanted);
          if (seq !== navSeq) return;
          state.file = file;
        }
        if (route.path === null) history.replaceState(null, '', fileHash(route.id, wanted));
      } else {
        state.file = null;
      }
    } else if (route.kind === 'global') {
      state.detail = null;
      if (overview.global.exists) {
        if (force || state.file?.project !== GLOBAL_ID) {
          state.file = await api.file(GLOBAL_ID, 'CLAUDE.md');
          if (seq !== navSeq) return;
        }
      } else {
        state.file = null;
      }
    } else if (route.kind === 'search') {
      state.search = route.q ? await api.search(route.q) : null;
      if (seq !== navSeq) return;
    }
  } catch (err) {
    if (seq !== navSeq) return;
    error = err instanceof Error ? err.message : String(err);
    // A project or file that disappeared: fall back to a clean state.
    state.file = null;
  }
  state.error = error;
  state.route = route;
}

function paneFor(route: Route): Pane {
  switch (route.kind) {
    case 'home':
      return 'projects';
    case 'search':
      return 'content';
    case 'global':
      return state.file ? 'content' : 'files';
    case 'project':
      return route.path || state.file ? 'content' : 'files';
  }
}

async function navigate(): Promise<void> {
  const route = parseHash(location.hash);
  await load(route, false);
  state.pane = paneFor(route);
  render();
}

async function refresh(): Promise<void> {
  await load(parseHash(location.hash), true);
  render();
}

function go(hash: string, replace = false): void {
  if (replace) {
    history.replaceState(null, '', hash);
    void navigate();
  } else if (location.hash === hash) {
    void navigate();
  } else {
    location.hash = hash;
  }
}

// ---------------------------------------------------------------------------
// Small UI pieces
// ---------------------------------------------------------------------------

let toastTimer: number | undefined;
function toast(message: string): void {
  toastEl.textContent = message;
  toastEl.classList.add('is-visible');
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl.classList.remove('is-visible'), 2200);
}

function timeEl(ms: number): HTMLElement {
  return h(
    'time',
    { datetime: new Date(ms).toISOString(), title: absoluteTime(ms), 'data-ms': ms },
    relativeTime(ms),
  );
}

function badgeEl(b: Badge): HTMLElement {
  return h('span', { class: `badge badge-${b.id}`, title: b.detail ?? b.label }, b.label);
}

function badgesEl(badges: readonly Badge[]): HTMLElement | null {
  return badges.length ? h('div', { class: 'item-badges' }, ...badges.map(badgeEl)) : null;
}

function copyButton(text: string, label: string): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn btn-icon',
      'aria-label': label,
      title: text,
      'on:click': () => {
        void copyText(text).then((ok) => toast(ok ? 'Path copied' : 'Could not copy'));
      },
    },
    'Copy path',
  );
}

function backButton(to: Pane, label: string): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: 'btn mobile-only',
      'on:click': () => {
        state.pane = to;
        layoutEl.dataset['pane'] = to;
      },
    },
    `← ${label}`,
  );
}

function sourceLabel(source: Overview['configDir']['source']): string {
  switch (source) {
    case 'flag':
      return 'the --config-dir option';
    case 'env':
      return 'the CLAUDE_CONFIG_DIR environment variable';
    default:
      return 'the default location (~/.claude)';
  }
}

function joinDisplay(base: string, ...parts: string[]): string {
  const sep = base.includes('\\') && !base.includes('/') ? '\\' : '/';
  return [base.replace(/[\\/]+$/, ''), ...parts].join(sep);
}

function configHint(): HTMLElement {
  return h(
    'p',
    null,
    'To look somewhere else, restart with ',
    h('code', null, 'claude-memory-viewer --config-dir /path/to/.claude'),
    ' or set the ',
    h('code', null, 'CLAUDE_CONFIG_DIR'),
    ' environment variable.',
  );
}

// ---------------------------------------------------------------------------
// Projects pane
// ---------------------------------------------------------------------------

function projectItem(p: ProjectSummary, selected: boolean): HTMLElement {
  const total = p.memoryFileCount + p.projectFileCount;
  return h(
    'li',
    null,
    h(
      'a',
      {
        class: 'item',
        href: fileHash(p.id, null),
        'data-item': '',
        'data-key': `p:${p.id}`,
        'aria-current': selected ? 'page' : null,
      },
      h('span', { class: 'item-title', title: p.realPath ?? p.id }, p.shortName),
      h(
        'span',
        { class: 'item-meta' },
        h('span', null, total === 0 ? 'no memory files' : plural(total, 'file')),
        p.latestMtimeMs !== null ? timeEl(p.latestMtimeMs) : null,
      ),
      badgesEl(p.badges),
    ),
  );
}

function renderProjects(): void {
  clear(projectsEl);
  const o = state.overview;
  const route = state.route;
  const head = h(
    'div',
    { class: 'pane-head' },
    h('h2', { class: 'pane-title' }, 'Memories'),
    h('p', { class: 'pane-sub' }, o ? plural(o.projects.length, 'project') : 'Loading…'),
  );
  append(projectsEl, [head]);
  if (!o) return;

  const globalLabel = o.global.entry
    ? h(
        'span',
        { class: 'item-meta' },
        h('span', null, formatBytes(o.global.entry.size)),
        timeEl(o.global.entry.mtimeMs),
      )
    : h('span', { class: 'item-meta' }, 'no CLAUDE.md yet');
  const list = h(
    'ul',
    { class: 'list', 'data-list': '', role: 'list' },
    h(
      'li',
      null,
      h(
        'a',
        {
          class: 'item',
          href: '#/global',
          'data-item': '',
          'data-key': 'global',
          'aria-current': route.kind === 'global' ? 'page' : null,
        },
        h('span', { class: 'item-title' }, 'Global'),
        globalLabel,
      ),
    ),
    ...o.projects.map((p) => projectItem(p, route.kind === 'project' && route.id === p.id)),
  );
  append(projectsEl, [list]);
  append(projectsEl, [
    h(
      'p',
      { class: 'hint' },
      h('span', { class: 'kbd' }, '/'),
      ' search · ',
      h('span', { class: 'kbd' }, 'j'),
      '/',
      h('span', { class: 'kbd' }, 'k'),
      ' move · ',
      h('span', { class: 'kbd' }, 'h'),
      '/',
      h('span', { class: 'kbd' }, 'l'),
      ' switch pane · ',
      h('span', { class: 'kbd' }, 'r'),
      ' raw/rendered',
    ),
  ]);
}

// ---------------------------------------------------------------------------
// Files pane
// ---------------------------------------------------------------------------

function fileItem(projectId: string, f: FileEntry, selectedPath: string | null): HTMLElement {
  return h(
    'li',
    null,
    h(
      'a',
      {
        class: 'item',
        href: fileHash(projectId, f.path),
        'data-item': '',
        'data-key': `f:${f.path}`,
        'aria-current': f.path === selectedPath ? 'page' : null,
      },
      h('span', { class: 'item-title' }, f.name),
      h(
        'span',
        { class: 'item-meta' },
        h('span', null, formatBytes(f.size)),
        f.lines !== null ? h('span', null, plural(f.lines, 'line')) : null,
        timeEl(f.mtimeMs),
      ),
      badgesEl(f.badges),
    ),
  );
}

function renderFiles(): void {
  clear(filesEl);
  const route = state.route;
  const o = state.overview;

  if (route.kind === 'global' && o) {
    append(filesEl, [
      h(
        'div',
        { class: 'pane-head' },
        backButton('projects', 'Projects'),
        h('h2', { class: 'pane-title' }, 'Global memory'),
        h('p', { class: 'pane-sub' }, o.global.path),
      ),
    ]);
    if (o.global.entry) {
      append(filesEl, [
        h('ul', { class: 'list', 'data-list': '', role: 'list' }, fileItem(GLOBAL_ID, o.global.entry, 'CLAUDE.md')),
      ]);
    }
    return;
  }

  const detail = state.detail;
  if (route.kind !== 'project' || !detail) {
    append(filesEl, [
      h(
        'div',
        { class: 'pane-head' },
        backButton('projects', 'Projects'),
        h('h2', { class: 'pane-title' }, 'Files'),
        h('p', { class: 'pane-sub' }, 'Select a project to see its memory files.'),
      ),
    ]);
    return;
  }

  const s = detail.summary;
  append(filesEl, [
    h(
      'div',
      { class: 'pane-head' },
      backButton('projects', 'Projects'),
      h('h2', { class: 'pane-title', title: s.id }, s.shortName),
      h(
        'p',
        { class: 'pane-sub' },
        s.realPath ?? 'Project folder could not be located',
        s.realPath ? copyButton(s.realPath, 'Copy project folder path') : null,
      ),
      s.badges.length ? h('div', { class: 'item-badges' }, ...s.badges.map(badgeEl)) : null,
    ),
  ]);

  if (detail.warnings.length) {
    append(filesEl, [
      h('div', { class: 'hint' }, ...detail.warnings.flatMap((w): Child[] => [w, h('br')])),
    ]);
  }

  const selected = state.file?.path ?? null;
  const memory = detail.files.filter((f) => f.scope === 'memory');
  const project = detail.files.filter((f) => f.scope === 'project');
  if (memory.length) {
    append(filesEl, [
      h('h3', { class: 'group-title' }, `Auto memory (${memory.length})`),
      h('ul', { class: 'list', 'data-list': '', role: 'list' }, ...memory.map((f) => fileItem(s.id, f, selected))),
    ]);
  }
  if (project.length) {
    append(filesEl, [
      h('h3', { class: 'group-title' }, `Project files (${project.length})`),
      h('ul', { class: 'list', 'data-list': '', role: 'list' }, ...project.map((f) => fileItem(s.id, f, selected))),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Content pane
// ---------------------------------------------------------------------------

function frontmatterCard(entries: readonly FrontmatterEntry[]): HTMLElement {
  const build = (items: readonly FrontmatterEntry[]): HTMLElement =>
    h(
      'dl',
      null,
      ...items.flatMap((e): Child[] => [
        h('dt', null, e.key),
        h('dd', null, typeof e.value === 'string' ? e.value : build(e.value)),
      ]),
    );
  return h('div', { class: 'card meta-card', 'aria-label': 'Frontmatter' }, build(entries));
}

function separatorEl(w: IndexWindow, cutoff: number): HTMLElement {
  return h(
    'div',
    { class: 'window-separator', role: 'separator' },
    h(
      'span',
      null,
      `not loaded into context (line ${cutoff} onward, limit ${w.maxLines} lines / ${Math.round(w.maxBytes / 1024)} KB)`,
    ),
  );
}

/** The one place HTML is assigned: the output of renderMarkdown(), which escapes all input first. */
function markdownBlock(text: string, extraClass = ''): HTMLElement {
  const el = h('div', { class: `markdown ${extraClass}`.trim() });
  el.innerHTML = renderMarkdown(text);
  return el;
}

function rawBlock(text: string, extraClass = ''): HTMLElement {
  return h('pre', { class: `raw ${extraClass}`.trim(), tabindex: '0' }, text);
}

function bodyEl(file: FileContent): HTMLElement {
  const lines = file.content.split(/\r?\n/);
  const bodyLines = lines.slice(file.bodyStartLine - 1);
  const w = file.indexWindow;
  const make = state.raw ? rawBlock : markdownBlock;
  const wrap = h('div', { 'data-body': '' });

  if (w && w.cutoffLine !== null) {
    const rel = w.cutoffLine - file.bodyStartLine + 1;
    const head = bodyLines.slice(0, Math.max(0, rel - 1)).join('\n');
    const tail = bodyLines.slice(Math.max(0, rel - 1)).join('\n');
    append(wrap, [
      head.trim() ? make(head) : null,
      separatorEl(w, w.cutoffLine),
      make(tail, 'beyond-window'),
    ]);
  } else {
    append(wrap, [make(bodyLines.join('\n'))]);
  }
  return wrap;
}

function indexNotice(file: FileContent, detail: ProjectDetail): HTMLElement | null {
  const idx = detail.index;
  if (file.path !== 'memory/MEMORY.md' || !idx.present) return null;
  const items: HTMLElement[] = [];
  if (idx.broken.length) {
    items.push(
      h(
        'li',
        null,
        `${plural(idx.broken.length, 'broken link')}: `,
        ...idx.broken.flatMap((b, i): Child[] => [i ? ', ' : '', h('code', null, b.target), ` (line ${b.line})`]),
      ),
    );
  }
  if (idx.orphans.length) {
    items.push(
      h(
        'li',
        null,
        `${plural(idx.orphans.length, 'file')} not in the index: `,
        ...idx.orphans.flatMap((o, i): Child[] => [
          i ? ', ' : '',
          h('a', { href: fileHash(detail.summary.id, `memory/${o}`) }, o),
        ]),
      ),
    );
  }
  const w = idx.window;
  if (w && w.cutoffLine !== null) {
    items.push(
      h(
        'li',
        null,
        `Lines ${w.cutoffLine}–${w.totalLines} are beyond the window loaded into context ` +
          `(${w.maxLines} lines / ${Math.round(w.maxBytes / 1024)} KB).`,
      ),
    );
  }
  if (!items.length) return null;
  return h(
    'div',
    { class: `notice${idx.broken.length ? ' is-error' : ''}`, role: 'note' },
    h('h3', null, 'Index check'),
    h('ul', null, ...items),
  );
}

function docView(file: FileContent): HTMLElement {
  const e = file.entry;
  const detail = state.detail;
  const rawToggle = h(
    'div',
    { class: 'seg', role: 'group', 'aria-label': 'View mode' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        'aria-pressed': String(!state.raw),
        'on:click': () => setRaw(false),
      },
      'Rendered',
    ),
    h(
      'button',
      {
        type: 'button',
        class: 'btn',
        'aria-pressed': String(state.raw),
        'on:click': () => setRaw(true),
      },
      'Raw',
    ),
  );
  const root = h(
    'article',
    { class: 'doc', 'aria-label': e.name },
    h(
      'div',
      { class: 'doc-head' },
      backButton('files', 'Files'),
      h('h2', { class: 'doc-title' }, e.name),
      ...e.badges.map(badgeEl),
      h('div', { class: 'toolbar' }, copyButton(e.absPath, 'Copy file path'), rawToggle),
    ),
    h(
      'p',
      { class: 'doc-meta' },
      `${e.scope === 'global' ? 'Global' : e.scope === 'memory' ? 'Auto memory' : 'Project file'} · ${formatBytes(e.size)}`,
      e.lines !== null ? ` · ${plural(e.lines, 'line')}` : '',
      ' · modified ',
      timeEl(e.mtimeMs),
      ' · ',
      h('span', { title: e.absPath }, e.absPath),
    ),
  );
  if (detail) append(root, [indexNotice(file, detail)]);
  if (file.frontmatter && file.frontmatter.length) append(root, [frontmatterCard(file.frontmatter)]);
  append(root, [bodyEl(file)]);
  return root;
}

function setRaw(raw: boolean): void {
  state.raw = raw;
  try {
    localStorage.setItem('cmv.raw', raw ? '1' : '0');
  } catch {
    // storage may be unavailable; the preference just does not persist
  }
  render();
}

function searchView(): HTMLElement {
  const route = state.route;
  const q = route.kind === 'search' ? route.q : '';
  const res = state.search;
  const root = h('section', { class: 'doc', 'aria-label': 'Search results' });
  append(root, [
    h('div', { class: 'doc-head' }, backButton('projects', 'Projects'), h('h2', { class: 'doc-title' }, 'Search')),
  ]);
  if (!q) {
    append(root, [h('p', { class: 'doc-meta' }, 'Type something to search every project and the global memory.')]);
    return root;
  }
  if (!res) {
    append(root, [h('p', { class: 'doc-meta' }, 'Searching…')]);
    return root;
  }
  append(root, [
    h(
      'p',
      { class: 'doc-meta' },
      `${plural(res.results.length, 'file')} matching “${res.query}”` +
        (res.truncated ? ' (showing the first results only)' : '') +
        ` · ${plural(res.indexed, 'file')} searched · case and accent insensitive`,
    ),
  ]);
  if (res.results.length === 0) {
    append(root, [
      h('div', { class: 'card' }, 'No matches. Try fewer words: every word must appear in the same file.'),
    ]);
    return root;
  }
  const groups = new Map<string, { label: string; items: SearchResponse['results'] }>();
  for (const r of res.results) {
    const g = groups.get(r.project) ?? { label: r.projectLabel, items: [] };
    g.items.push(r);
    groups.set(r.project, g);
  }
  for (const [projectId, g] of groups) {
    const group = h('div', { class: 'result-group' }, h('h3', null, g.label));
    for (const r of g.items) {
      group.appendChild(
        h(
          'a',
          { class: 'result', href: fileHash(projectId, r.path), 'data-item': '', 'data-key': `r:${projectId}:${r.path}` },
          h('span', { class: 'result-name' }, r.name),
          h('span', { class: 'item-meta' }, r.matchCount === 0 ? 'file name matches' : plural(r.matchCount, 'matching line')),
          ...r.matches.map((m) =>
            h(
              'p',
              { class: 'snippet' },
              h('span', { class: 'ln' }, `L${m.line}`),
              ...m.segments.map((seg) => (seg.hit ? h('mark', null, seg.text) : seg.text)),
            ),
          ),
        ),
      );
    }
    root.appendChild(group);
  }
  return root;
}

function emptyState(title: string, ...body: Child[]): HTMLElement {
  return h('div', { class: 'empty' }, h('h2', null, title), ...body);
}

function homeView(o: Overview): HTMLElement {
  if (!o.configDir.exists) {
    return emptyState(
      'No Claude Code config directory found',
      h('p', null, 'Looked in:', h('code', { class: 'loc' }, o.configDir.path), `(from ${sourceLabel(o.configDir.source)})`),
      configHint(),
    );
  }
  if (!o.configDir.projectsDirExists || o.projects.length === 0) {
    return emptyState(
      'No projects found',
      h(
        'p',
        null,
        'Looked in:',
        h('code', { class: 'loc' }, joinDisplay(o.configDir.path, 'projects')),
        o.configDir.projectsDirExists
          ? 'The folder exists but has no project folders yet. Memories appear here once Claude Code has worked in a project.'
          : 'That folder does not exist yet.',
      ),
      configHint(),
    );
  }
  const withMemory = o.projects.filter((p) => p.memoryFileCount > 0).length;
  return emptyState(
    'Claude Memory Viewer',
    h(
      'p',
      null,
      `${plural(o.projects.length, 'project')} found in `,
      h('code', null, o.configDir.path),
      `, ${withMemory} with auto memory files.`,
    ),
    h('p', null, 'Pick “Global” or a project on the left. Nothing here can modify your files.'),
  );
}

function renderContent(): void {
  clear(contentEl);
  const o = state.overview;
  const route = state.route;
  contentEl.setAttribute('aria-busy', 'false');

  if (state.error) {
    append(contentEl, [emptyState('Something went wrong', h('p', null, state.error))]);
    return;
  }
  if (!o) {
    append(contentEl, [emptyState('Loading…')]);
    return;
  }
  if (route.kind === 'search') {
    append(contentEl, [searchView()]);
    return;
  }
  if (route.kind === 'home') {
    append(contentEl, [homeView(o)]);
    return;
  }
  if (state.file) {
    append(contentEl, [docView(state.file)]);
    return;
  }
  if (route.kind === 'global') {
    append(contentEl, [
      emptyState(
        'No global CLAUDE.md',
        h('p', null, 'Looked for:', h('code', { class: 'loc' }, o.global.path)),
        h('p', null, 'It is optional. Claude Code reads it from the config directory when it exists.'),
        configHint(),
      ),
    ]);
    return;
  }
  const detail = state.detail;
  if (detail) {
    const s = detail.summary;
    const places: Child[] = [h('code', { class: 'loc' }, joinDisplay(o.configDir.path, 'projects', s.id, 'memory'))];
    if (s.realPath && s.pathExists) {
      for (const name of ['CLAUDE.md', '.claude/CLAUDE.md', 'CLAUDE.local.md']) {
        places.push(h('code', { class: 'loc' }, joinDisplay(s.realPath, ...name.split('/'))));
      }
    }
    append(contentEl, [
      emptyState(
        'No memory files for this project',
        h('p', null, 'Looked in:', ...places),
        s.realPath && !s.pathExists
          ? h('p', null, 'The project folder no longer exists on disk, so its CLAUDE.md files cannot be checked.')
          : null,
        configHint(),
      ),
    ]);
  }
}

// ---------------------------------------------------------------------------
// Render orchestration (keeps scroll and focus across live updates)
// ---------------------------------------------------------------------------

let lastContentKey = '';

function focusByKey(key: string): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-key]')) {
    if (el.dataset['key'] === key) {
      el.focus({ preventScroll: true });
      return;
    }
  }
}

function render(): void {
  const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusKey = active?.dataset['key'] ?? null;
  const scroll = { p: projectsEl.scrollTop, f: filesEl.scrollTop, c: contentEl.scrollTop };

  renderProjects();
  renderFiles();
  renderContent();
  layoutEl.dataset['pane'] = state.pane;

  const contentKey = `${state.route.kind}|${state.file?.project ?? ''}|${state.file?.path ?? ''}|${state.raw}|${
    state.route.kind === 'search' ? state.route.q : ''
  }`;
  projectsEl.scrollTop = scroll.p;
  filesEl.scrollTop = scroll.f;
  contentEl.scrollTop = contentKey === lastContentKey ? scroll.c : 0;
  lastContentKey = contentKey;
  if (focusKey) focusByKey(focusKey);

  document.title =
    state.file && state.route.kind !== 'search' ? `${state.file.entry.name} · Claude Memory Viewer` : 'Claude Memory Viewer';
}

// ---------------------------------------------------------------------------
// Internal links, search box, keyboard, live updates
// ---------------------------------------------------------------------------

contentEl.addEventListener('click', (event) => {
  const target = event.target instanceof Element ? event.target.closest('a.md-internal') : null;
  if (!target) return;
  event.preventDefault();
  const link = target.getAttribute('data-md-link') ?? '';
  const file = state.file;
  if (!file) return;
  const resolved = resolveRelative(file.path, link);
  const detail = state.detail;
  const hit = resolved && detail ? detail.files.find((f) => f.path === resolved) : null;
  if (hit) go(fileHash(file.project, hit.path));
  else toast(`Cannot open “${link}”: not one of this project’s memory files.`);
});

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let timer: number | undefined;
  return (...args: A) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

const onSearchInput = debounce(() => {
  const q = searchInput.value.trim();
  if (!q) {
    if (state.route.kind === 'search') go(state.returnHash, true);
    return;
  }
  if (state.route.kind !== 'search') state.returnHash = location.hash || '#/';
  go(`#/search/${enc(q)}`, state.route.kind === 'search');
}, 220);

searchInput.addEventListener('input', onSearchInput);
searchForm.addEventListener('submit', (e) => e.preventDefault());

function isTyping(el: EventTarget | null): boolean {
  return el instanceof HTMLElement && (el.matches('input, textarea, select') || el.isContentEditable);
}

const PANES: readonly { id: Pane; el: HTMLElement }[] = [
  { id: 'projects', el: projectsEl },
  { id: 'files', el: filesEl },
  { id: 'content', el: contentEl },
];

function currentPaneIndex(): number {
  const active = document.activeElement;
  return PANES.findIndex((p) => active && p.el.contains(active));
}

function items(pane: HTMLElement): HTMLElement[] {
  return [...pane.querySelectorAll<HTMLElement>('[data-item]')];
}

function focusPane(index: number): void {
  const pane = PANES[Math.max(0, Math.min(PANES.length - 1, index))];
  if (!pane) return;
  state.pane = pane.id;
  layoutEl.dataset['pane'] = pane.id;
  if (pane.id === 'content') {
    contentEl.focus();
    return;
  }
  const list = items(pane.el);
  (list.find((el) => el.getAttribute('aria-current') === 'page') ?? list[0])?.focus();
}

function moveInList(delta: number): void {
  let idx = currentPaneIndex();
  if (idx < 0 || PANES[idx]?.id === 'content') {
    idx = items(filesEl).length ? 1 : 0;
    const list = items(PANES[idx]?.el ?? projectsEl);
    (list.find((el) => el.getAttribute('aria-current') === 'page') ?? list[0])?.focus();
    return;
  }
  const list = items(PANES[idx]?.el ?? projectsEl);
  const at = list.indexOf(document.activeElement as HTMLElement);
  const next = list[Math.max(0, Math.min(list.length - 1, at < 0 ? 0 : at + delta))];
  next?.focus();
}

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === 'Escape' && e.target === searchInput) {
    searchInput.value = '';
    searchInput.blur();
    if (state.route.kind === 'search') go(state.returnHash, true);
    return;
  }
  if (isTyping(e.target)) return;
  if (e.key === '/') {
    e.preventDefault();
    searchInput.focus();
    searchInput.select();
    return;
  }
  const inContent = PANES[currentPaneIndex()]?.id === 'content';
  switch (e.key) {
    case 'j':
    case 'ArrowDown':
      if (e.key === 'ArrowDown' && inContent) return; // let the page scroll
      e.preventDefault();
      moveInList(1);
      break;
    case 'k':
    case 'ArrowUp':
      if (e.key === 'ArrowUp' && inContent) return;
      e.preventDefault();
      moveInList(-1);
      break;
    case 'h':
    case 'ArrowLeft':
      e.preventDefault();
      focusPane((currentPaneIndex() < 0 ? 1 : currentPaneIndex()) - 1);
      break;
    case 'l':
    case 'ArrowRight':
      e.preventDefault();
      focusPane((currentPaneIndex() < 0 ? 0 : currentPaneIndex()) + 1);
      break;
    case 'r':
      if (state.file && state.route.kind !== 'search') setRaw(!state.raw);
      break;
    default:
  }
});

function setLive(status: 'connecting' | 'live' | 'offline'): void {
  liveEl.className = `live ${status === 'live' ? 'is-live' : status === 'offline' ? 'is-offline' : ''}`.trim();
  liveEl.textContent = status === 'live' ? 'live' : status === 'offline' ? 'reconnecting…' : 'connecting…';
}

const scheduleRefresh = debounce(() => void refresh(), 150);

function connectEvents(): void {
  if (typeof EventSource === 'undefined') {
    setLive('offline');
    return;
  }
  setLive('connecting');
  const es = new EventSource('/api/events');
  let wasOffline = false;
  es.onopen = () => {
    setLive('live');
    if (wasOffline) scheduleRefresh(); // catch up on anything missed while disconnected
    wasOffline = false;
  };
  es.addEventListener('changed', () => scheduleRefresh());
  es.onerror = () => {
    wasOffline = true;
    setLive('offline');
  };
}

window.addEventListener('hashchange', () => void navigate());

window.setInterval(() => {
  for (const t of document.querySelectorAll<HTMLElement>('time[data-ms]')) {
    const ms = Number(t.dataset['ms']);
    if (Number.isFinite(ms)) t.textContent = relativeTime(ms);
  }
}, 30_000);

try {
  state.raw = localStorage.getItem('cmv.raw') === '1';
} catch {
  state.raw = false;
}

const initial = parseHash(location.hash);
if (initial.kind === 'search') searchInput.value = initial.q;
render();
void navigate();
connectEvents();
