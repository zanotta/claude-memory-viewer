import { watch, type FSWatcher } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { Scanner } from './scanner.js';
import type { ChangeEvent } from './shared/types.js';

export interface WatcherOptions {
  scanner: Scanner;
  onChange: (event: ChangeEvent) => void;
  /** Quiet period before a burst of file events becomes one notification. */
  debounceMs?: number;
  /** Polling interval used when native watching is unavailable. */
  pollMs?: number;
  /** Interval of the light poll that covers project-level CLAUDE.md files in native mode. */
  projectPollMs?: number;
  /** Skip `fs.watch` entirely (also what happens when it fails). */
  forcePolling?: boolean;
}

export interface Watcher {
  mode: 'native' | 'polling';
  close(): void;
}

const GLOBAL = '@global';

interface Touched {
  project: string | null;
  path: string | null;
}

/** Maps an `fs.watch` filename under `<config>/projects` to what changed, or null to ignore it. */
export function classifyProjectsEvent(filename: string | null): Touched | null {
  if (filename === null) return { project: null, path: null };
  const parts = filename.split(/[\\/]+/).filter(Boolean);
  const id = parts[0];
  if (!id) return { project: null, path: null };
  if (parts.length === 1) return { project: id, path: null }; // folder added or removed
  if (parts[1] !== 'memory') return null; // transcripts and session folders
  if (parts.length === 2) return { project: id, path: null };
  const last = parts[parts.length - 1] ?? '';
  const ext = path.extname(last).toLowerCase();
  if (ext !== '' && ext !== '.md') return null; // editor temp files etc.
  return { project: id, path: ext === '.md' ? `memory/${parts.slice(2).join('/')}` : null };
}

function diffSnapshots(before: Map<string, string>, after: Map<string, string>): Touched[] {
  const out: Touched[] = [];
  const keys = new Set([...before.keys(), ...after.keys()]);
  for (const key of keys) {
    if (before.get(key) === after.get(key)) continue;
    const sep = key.indexOf('|');
    out.push({ project: key.slice(0, sep), path: key.slice(sep + 1) });
  }
  return out;
}

export async function startWatcher(options: WatcherOptions): Promise<Watcher> {
  const { scanner, onChange } = options;
  const debounceMs = options.debounceMs ?? 250;
  const pollMs = options.pollMs ?? 3000;
  const projectPollMs = options.projectPollMs ?? 5000;

  let closed = false;
  let mode: Watcher['mode'] = 'polling';
  const watchers: FSWatcher[] = [];
  const timers: NodeJS.Timeout[] = [];
  const pending = new Map<string, Touched>();
  let flushTimer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    flushTimer = undefined;
    if (closed || pending.size === 0) return;
    const touched = [...pending.values()];
    pending.clear();
    const projects = new Set(touched.map((t) => t.project));
    let event: ChangeEvent;
    if (touched.length === 1 && touched[0]) {
      event = { type: 'changed', project: touched[0].project, path: touched[0].path };
    } else if (projects.size === 1 && !projects.has(null)) {
      event = { type: 'changed', project: touched[0]?.project ?? null, path: null };
    } else {
      event = { type: 'changed', project: null, path: null };
    }
    onChange(event);
  };

  const touch = (t: Touched): void => {
    if (closed) return;
    pending.set(`${t.project ?? '*'}|${t.path ?? '*'}`, t);
    clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, debounceMs);
  };

  const startPolling = (): void => {
    mode = 'polling';
    let previous: Map<string, string> | null = null;
    let busy = false;
    const tick = async (): Promise<void> => {
      if (busy || closed) return;
      busy = true;
      try {
        const next = await scanner.snapshot();
        if (previous) for (const t of diffSnapshots(previous, next)) touch(t);
        previous = next;
      } catch {
        // transient filesystem error: try again on the next tick
      } finally {
        busy = false;
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), pollMs);
    timer.unref();
    timers.push(timer);
  };

  const startNative = (): boolean => {
    try {
      const projectsWatcher = watch(scanner.projectsDir, { recursive: true, persistent: false }, (_type, filename) => {
        const touched = classifyProjectsEvent(filename === null ? null : String(filename));
        if (touched) touch(touched);
      });
      projectsWatcher.on('error', () => degrade());
      watchers.push(projectsWatcher);

      const configWatcher = watch(scanner.configDir, { persistent: false }, (_type, filename) => {
        const name = filename === null ? null : String(filename);
        if (name === null || name === 'CLAUDE.md') touch({ project: GLOBAL, path: 'CLAUDE.md' });
      });
      configWatcher.on('error', () => degrade());
      watchers.push(configWatcher);
      return true;
    } catch {
      closeNative();
      return false;
    }
  };

  // Native mode cannot see CLAUDE.md files inside the projects themselves.
  const startProjectFilePoll = (): void => {
    let previous: Map<string, string> | null = null;
    let busy = false;
    const timer = setInterval(() => {
      if (busy || closed) return;
      busy = true;
      void scanner
        .snapshot(true)
        .then((next) => {
          if (previous) for (const t of diffSnapshots(previous, next)) touch(t);
          previous = next;
        })
        .catch(() => undefined)
        .finally(() => {
          busy = false;
        });
    }, projectPollMs);
    timer.unref();
    timers.push(timer);
  };

  const closeNative = (): void => {
    for (const w of watchers.splice(0)) {
      try {
        w.close();
      } catch {
        // already closed
      }
    }
    for (const t of timers.splice(0)) clearInterval(t);
  };

  function degrade(): void {
    if (closed || mode === 'polling') return;
    closeNative();
    startPolling();
    touch({ project: null, path: null });
  }

  if (!options.forcePolling) {
    let isDir = false;
    try {
      isDir = (await stat(scanner.projectsDir)).isDirectory();
    } catch {
      isDir = false;
    }
    if (isDir && startNative()) {
      mode = 'native';
      startProjectFilePoll();
    } else {
      startPolling();
    }
  } else {
    startPolling();
  }

  return {
    get mode() {
      return mode;
    },
    close() {
      closed = true;
      clearTimeout(flushTimer);
      closeNative();
    },
  };
}
