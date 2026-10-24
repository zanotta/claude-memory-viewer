import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Scanner } from '../dist/scanner.js';
import { SearchIndex } from '../dist/search.js';
import type { ChangeEvent } from '../dist/shared/types.js';
import { classifyProjectsEvent, startWatcher, type Watcher } from '../dist/watcher.js';
import { makeProject, makeTempDir, write } from './helpers.js';
import { startTestServer } from './http-helpers.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(fn: () => T | undefined | false, timeoutMs = 8000, what = 'condition'): Promise<T> {
  const start = Date.now();
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(25);
  }
}

describe('classifyProjectsEvent', () => {
  it('maps memory files and ignores transcripts', () => {
    assert.deepEqual(classifyProjectsEvent('-p/memory/a.md'), { project: '-p', path: 'memory/a.md' });
    assert.deepEqual(classifyProjectsEvent('-p\\memory\\sub\\b.md'), { project: '-p', path: 'memory/sub/b.md' });
    assert.deepEqual(classifyProjectsEvent('-p/memory'), { project: '-p', path: null });
    assert.deepEqual(classifyProjectsEvent('-p'), { project: '-p', path: null });
    assert.deepEqual(classifyProjectsEvent('-p/memory/sub'), { project: '-p', path: null });
    assert.deepEqual(classifyProjectsEvent(null), { project: null, path: null });
    assert.equal(classifyProjectsEvent('-p/session.jsonl'), null);
    assert.equal(classifyProjectsEvent('-p/0f3a-uuid/subagents/x.md'), null);
    assert.equal(classifyProjectsEvent('-p/memory/a.md.swp'), null);
  });
});

async function withWatcher(
  forcePolling: boolean,
  body: (ctx: { events: ChangeEvent[]; memoryDir: string; id: string; projectPath: string; configDir: string; watcher: Watcher }) => Promise<void>,
): Promise<void> {
  const t = await makeTempDir();
  let watcher: Watcher | undefined;
  try {
    const p = await makeProject(t.dir, 'watched');
    await write(path.join(p.memoryDir, 'seed.md'), 'seed\n');
    await write(path.join(p.projectPath, 'CLAUDE.md'), 'project\n');
    const events: ChangeEvent[] = [];
    watcher = await startWatcher({
      scanner: new Scanner({ configDir: p.configDir }),
      onChange: (e) => events.push(e),
      debounceMs: 60,
      pollMs: 100,
      projectPollMs: 100,
      forcePolling,
    });
    await sleep(forcePolling ? 300 : 500); // let the first snapshot / watcher settle
    await body({ events, memoryDir: p.memoryDir, id: p.id, projectPath: p.projectPath, configDir: p.configDir, watcher });
  } finally {
    watcher?.close();
    await t.cleanup();
  }
}

for (const forcePolling of [false, true]) {
  describe(`watcher (${forcePolling ? 'polling' : 'native'})`, () => {
    it('reports a changed memory file with its project and path', async () => {
      await withWatcher(forcePolling, async ({ events, memoryDir, id, watcher }) => {
        assert.equal(watcher.mode, forcePolling ? 'polling' : 'native');
        await write(path.join(memoryDir, 'new.md'), 'hello\n');
        await waitFor(() => events.find((e) => e.project === id && (e.path === 'memory/new.md' || e.path === null)), 8000, 'memory event');
      });
    });

    it('coalesces a burst of writes into few notifications', async () => {
      await withWatcher(forcePolling, async ({ events, memoryDir, id }) => {
        for (let i = 0; i < 12; i++) await write(path.join(memoryDir, `burst-${i}.md`), `n${i}\n`);
        await waitFor(() => events.some((e) => e.project === id), 8000, 'burst event');
        await sleep(400);
        assert.ok(events.length <= 3, `got ${events.length} events for 12 writes`);
      });
    });

    it('notices edits and deletions', async () => {
      await withWatcher(forcePolling, async ({ events, memoryDir, id }) => {
        await write(path.join(memoryDir, 'seed.md'), 'seed changed with more text\n');
        await waitFor(() => events.find((e) => e.project === id), 8000, 'edit event');
        events.length = 0;
        await rm(path.join(memoryDir, 'seed.md'));
        await waitFor(() => events.find((e) => e.project === id), 8000, 'delete event');
      });
    });

    it('notices project-level CLAUDE.md changes', async () => {
      await withWatcher(forcePolling, async ({ events, projectPath, id }) => {
        await write(path.join(projectPath, 'CLAUDE.md'), 'project, edited and longer\n');
        await waitFor(() => events.find((e) => e.project === id && e.path === 'project/CLAUDE.md'), 8000, 'project file event');
      });
    });

    it('notices the global CLAUDE.md', async () => {
      await withWatcher(forcePolling, async ({ events, configDir }) => {
        await write(path.join(configDir, 'CLAUDE.md'), '# global\n');
        await waitFor(() => events.find((e) => e.project === '@global'), 8000, 'global event');
      });
    });

    it('stays quiet for transcript writes', async () => {
      await withWatcher(forcePolling, async ({ events, memoryDir }) => {
        const projectDir = path.dirname(memoryDir);
        await write(path.join(projectDir, 'session-2.jsonl'), '{"a":1}\n');
        await mkdir(path.join(projectDir, '0f3a'), { recursive: true });
        await write(path.join(projectDir, '0f3a', 'notes.md'), 'x\n');
        await sleep(600);
        if (!forcePolling) assert.deepEqual(events, []);
      });
    });
  });
}

describe('watcher without a projects directory', () => {
  it('falls back to polling and picks up the directory when it appears', async () => {
    const t = await makeTempDir();
    let watcher: Watcher | undefined;
    try {
      const configDir = path.join(t.dir, 'cfg');
      const events: ChangeEvent[] = [];
      watcher = await startWatcher({
        scanner: new Scanner({ configDir }),
        onChange: (e) => events.push(e),
        debounceMs: 40,
        pollMs: 100,
      });
      assert.equal(watcher.mode, 'polling');
      await sleep(250);
      await write(path.join(configDir, 'CLAUDE.md'), '# hi\n');
      await waitFor(() => events.find((e) => e.project === '@global'), 8000, 'global event');
    } finally {
      watcher?.close();
      await t.cleanup();
    }
  });
});

describe('live updates end to end', () => {
  it('a file edit reaches SSE clients and the search index', async () => {
    const t = await makeTempDir();
    let watcher: Watcher | undefined;
    const s0 = await makeProject(t.dir, 'e2e');
    await write(path.join(s0.memoryDir, 'a.md'), 'old content\n');
    const scanner = new Scanner({ configDir: s0.configDir });
    const search = new SearchIndex(scanner);
    const server = await startTestServer(s0.configDir, { scanner, search });
    try {
      watcher = await startWatcher({
        scanner,
        debounceMs: 60,
        pollMs: 100,
        projectPollMs: 100,
        onChange: (e) => void search.refresh().finally(() => server.running.events.broadcast(e)),
      });
      assert.equal((await search.search('old')).results.length, 1);

      const received: string[] = [];
      const req = http.get(
        { host: '127.0.0.1', port: server.port, path: '/api/events', headers: { Host: `localhost:${server.port}` } },
        (res) => {
          res.setEncoding('utf8');
          res.on('data', (c: string) => received.push(c));
        },
      );
      req.on('error', () => undefined);
      await waitFor(() => received.join('').includes('connected'), 3000, 'sse connect');
      await sleep(400);
      await write(path.join(s0.memoryDir, 'a.md'), 'brand-new-phrase appears\n');
      await waitFor(() => received.join('').includes('event: changed'), 8000, 'sse changed event');
      const fresh = await server.get('/api/search?q=brand-new-phrase');
      assert.equal((fresh.json() as { results: unknown[] }).results.length, 1);
      assert.equal(((await server.get('/api/search?q=old')).json() as { results: unknown[] }).results.length, 0);
      req.destroy();
    } finally {
      watcher?.close();
      await server.stop();
      await t.cleanup();
    }
  });
});
