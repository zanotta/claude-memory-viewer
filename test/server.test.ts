import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import type { FileContent, Overview, ProjectDetail } from '../dist/shared/types.js';
import { listenWithRetry } from '../dist/server.js';
import { startTestServer, request } from './http-helpers.js';
import { fixtureHome, makeProject, makeTempDir, write } from './helpers.js';

const APP = '-home-ana-dev-app';
const fileUrl = (project: string, p: string) =>
  `/api/file?project=${encodeURIComponent(project)}&path=${encodeURIComponent(p)}`;

describe('server: API and headers', () => {
  it('serves the overview with the required security headers', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const r = await s.get('/api/overview');
      assert.equal(r.status, 200);
      const csp = String(r.headers['content-security-policy']);
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /frame-ancestors 'none'/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(r.headers['referrer-policy'], 'no-referrer');
      assert.equal(r.headers['cache-control'], 'no-store');
      assert.match(String(r.headers['content-type']), /application\/json/);
      const o = r.json() as Overview;
      assert.equal(o.projects.length, 4);
      assert.equal(o.global.exists, true);
    } finally {
      await s.stop();
    }
  });

  it('serves a project detail and file content', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const d = (await s.get(`/api/projects/${encodeURIComponent(APP)}`)).json() as ProjectDetail;
      assert.equal(d.summary.id, APP);
      assert.equal(d.index.orphans[0], 'orphan.md');
      const f = (await s.get(fileUrl(APP, 'memory/debugging.md'))).json() as FileContent;
      assert.match(f.content, /Debugging/);
      assert.equal(f.frontmatter?.[0]?.value, 'debugging-notes');
      const g = (await s.get(fileUrl('@global', 'CLAUDE.md'))).json() as FileContent;
      assert.match(g.content, /Global preferences/);
    } finally {
      await s.stop();
    }
  });

  it('serves static files with the right content type and the same headers', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const idx = await s.get('/');
      assert.equal(idx.status, 200);
      assert.match(String(idx.headers['content-type']), /text\/html/);
      assert.match(String(idx.headers['content-security-policy']), /frame-ancestors 'none'/);
      assert.match(String((await s.get('/app.js')).headers['content-type']), /text\/javascript/);
      assert.match(String((await s.get('/style.css')).headers['content-type']), /text\/css/);
      assert.equal((await s.get('/nope.js')).status, 404);
      assert.equal((await s.get('/api/nope')).status, 404);
    } finally {
      await s.stop();
    }
  });

  it('answers HEAD without a body', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const r = await request(s.port, { method: 'HEAD', path: '/api/overview' });
      assert.equal(r.status, 200);
      assert.equal(r.body, '');
    } finally {
      await s.stop();
    }
  });
});

describe('server: Host header and cross-site protection', () => {
  it('rejects unexpected Host headers with 403 on every route', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      for (const p of ['/', '/api/overview', '/app.js', '/api/events']) {
        for (const host of ['evil.example', `evil.example:${s.port}`, `localhost:${s.port + 1}`, 'localhost']) {
          const r = await s.get(p, { host });
          assert.equal(r.status, 403, `${p} with Host ${host}`);
        }
      }
    } finally {
      await s.stop();
    }
  });

  it('accepts the loopback spellings', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      for (const host of [`localhost:${s.port}`, `127.0.0.1:${s.port}`, `[::1]:${s.port}`]) {
        assert.equal((await s.get('/api/overview', { host })).status, 200, host);
      }
    } finally {
      await s.stop();
    }
  });

  it('refuses cross-site API calls from browsers', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      assert.equal((await s.get('/api/overview', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
      assert.equal((await s.get('/api/overview', { headers: { 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
    } finally {
      await s.stop();
    }
  });
});

describe('server: methods', () => {
  it('answers 405 to anything but GET and HEAD, and writes nothing', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'ro');
      await write(path.join(p.memoryDir, 'a.md'), 'A\n');
      const before = (await stat(path.join(p.memoryDir, 'a.md'))).mtimeMs;
      const s = await startTestServer(p.configDir);
      try {
        for (const method of ['POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'TRACE']) {
          for (const route of ['/api/overview', fileUrl(p.id, 'memory/a.md'), '/', '/api/events']) {
            const r = await request(s.port, { method, path: route });
            assert.equal(r.status, 405, `${method} ${route}`);
            assert.equal(r.headers['allow'], 'GET, HEAD');
          }
        }
        assert.deepEqual(await readdir(p.memoryDir), ['a.md']);
        assert.equal((await stat(path.join(p.memoryDir, 'a.md'))).mtimeMs, before);
      } finally {
        await s.stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe('server: path traversal', () => {
  it('rejects traversal attempts in every spelling', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const bad = [
        'memory/../../../../etc/passwd',
        'memory/../session-1.jsonl',
        'memory/../../-home-ana-dev-acentos/memory/configuracao.md',
        '../CLAUDE.md',
        'memory/./debugging.md',
        '/etc/passwd',
        'memory//debugging.md',
        'memory/sub/../debugging.md',
        'memory\\..\\..\\x.md',
        'memory/debugging.md\0',
        'memory/%2e%2e/debugging.md',
        '',
      ];
      for (const p of bad) {
        const r = await s.get(fileUrl(APP, p));
        assert.ok([400, 403, 404].includes(r.status), `${JSON.stringify(p)} -> ${r.status}`);
        assert.doesNotMatch(r.body, /root:|Global preferences|Orphan/);
      }
      // Raw (not re-encoded) variants in the URL itself.
      for (const raw of [
        `/api/file?project=${APP}&path=memory/%2e%2e/%2e%2e/x.md`,
        `/api/file?project=${APP}&path=memory%2F..%2F..%2Fx.md`,
        `/api/file?project=${APP}&path=memory/%00.md`,
        `/api/file?project=${APP}&path=%2Fetc%2Fpasswd`,
      ]) {
        const r = await s.get(raw);
        assert.ok([400, 403, 404].includes(r.status), `${raw} -> ${r.status}`);
      }
    } finally {
      await s.stop();
    }
  });

  it('rejects unknown projects and ids that are not real folders', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      for (const id of ['..', '../..', '.', '-home-ana-dev-app/..', '-nope', '', '%2e%2e', 'memory']) {
        const a = await s.get(fileUrl(id, 'memory/MEMORY.md'));
        assert.ok([400, 404].includes(a.status), `file id ${JSON.stringify(id)} -> ${a.status}`);
      }
      for (const raw of ['/api/projects/..', '/api/projects/%2e%2e', '/api/projects/a%2Fb', '/api/projects/', '/api/projects/%']) {
        const r = await s.get(raw);
        assert.ok([400, 404].includes(r.status), `${raw} -> ${r.status}`);
      }
    } finally {
      await s.stop();
    }
  });

  it('serves only files from the static listing', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2fpackage.json', '/app.js/../../x', '//etc/passwd', '/index.html%00']) {
        const r = await s.get(p);
        assert.ok([400, 404].includes(r.status), `${p} -> ${r.status}`);
      }
    } finally {
      await s.stop();
    }
  });

  it('refuses symlinks that leave the memory folder', async (ctx) => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'links');
      await write(path.join(t.dir, 'outside', 'secret.md'), 'TOP-SECRET\n');
      try {
        await symlink(path.join(t.dir, 'outside', 'secret.md'), path.join(p.memoryDir, 'link.md'));
        await symlink(path.join(t.dir, 'outside'), path.join(p.memoryDir, 'linkdir'), 'dir');
      } catch {
        ctx.skip('symlinks are not available on this system');
        return;
      }
      await write(path.join(p.memoryDir, 'ok.md'), 'fine\n');
      const s = await startTestServer(p.configDir);
      try {
        for (const rel of ['memory/link.md', 'memory/linkdir/secret.md']) {
          const r = await s.get(fileUrl(p.id, rel));
          assert.equal(r.status, 403, rel);
          assert.doesNotMatch(r.body, /TOP-SECRET/);
        }
        assert.equal((await s.get(fileUrl(p.id, 'memory/ok.md'))).status, 200);
      } finally {
        await s.stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  it('applies extension, size and binary limits', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'limits');
      await write(path.join(p.memoryDir, 'data.json'), '{}');
      await write(path.join(p.memoryDir, 'big.md'), 'x'.repeat(2 * 1024 * 1024 + 10));
      await write(path.join(p.memoryDir, 'bin.md'), 'abc\u0000def');
      await write(path.join(p.memoryDir, 'note.txt'), 'plain\n');
      const s = await startTestServer(p.configDir);
      try {
        assert.equal((await s.get(fileUrl(p.id, 'memory/data.json'))).status, 415);
        assert.equal((await s.get(fileUrl(p.id, 'memory/big.md'))).status, 413);
        assert.equal((await s.get(fileUrl(p.id, 'memory/bin.md'))).status, 415);
        assert.equal((await s.get(fileUrl(p.id, 'memory/note.txt'))).status, 200);
        assert.equal((await s.get(fileUrl(p.id, 'memory/missing.md'))).status, 404);
      } finally {
        await s.stop();
      }
    } finally {
      await t.cleanup();
    }
  });

  it('only exposes the fixed project-level file names', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'proj');
      await write(path.join(p.projectPath, 'CLAUDE.md'), '# Project memory\n');
      await write(path.join(p.projectPath, 'README.md'), '# Not allowed\n');
      await write(path.join(t.dir, 'work', 'other.md'), '# Sibling\n');
      const s = await startTestServer(p.configDir);
      try {
        assert.equal((await s.get(fileUrl(p.id, 'project/CLAUDE.md'))).status, 200);
        for (const rel of ['project/README.md', 'project/../other.md', 'project/.claude/../README.md', 'project/']) {
          const r = await s.get(fileUrl(p.id, rel));
          assert.ok([400, 404].includes(r.status), `${rel} -> ${r.status}`);
        }
        assert.equal((await s.get(fileUrl(p.id, 'CLAUDE.md'))).status, 400);
        assert.equal((await s.get(fileUrl('@global', 'memory/x.md'))).status, 404);
      } finally {
        await s.stop();
      }
    } finally {
      await t.cleanup();
    }
  });
});

describe('server: events and ports', () => {
  it('streams change events to connected clients', async () => {
    const s = await startTestServer(fixtureHome());
    try {
      const received = await new Promise<string>((resolve, reject) => {
        const req = http.get(
          { host: '127.0.0.1', port: s.port, path: '/api/events', headers: { Host: `localhost:${s.port}` } },
          (res) => {
            assert.equal(res.statusCode, 200);
            assert.match(String(res.headers['content-type']), /text\/event-stream/);
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk: string) => {
              buf += chunk;
              if (buf.includes('connected') && !buf.includes('event: changed')) {
                s.running.events.broadcast({ type: 'changed', project: APP, path: 'memory/MEMORY.md' });
              }
              if (buf.includes('event: changed')) {
                req.destroy();
                resolve(buf);
              }
            });
          },
        );
        req.on('error', (e) => {
          if ((e as NodeJS.ErrnoException).code !== 'ECONNRESET') reject(e);
        });
      });
      assert.match(received, /data: \{"type":"changed","project":"-home-ana-dev-app","path":"memory\/MEMORY\.md"\}/);
    } finally {
      await s.stop();
    }
  });

  it('tries the next ports when the first one is busy', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    const probe = http.createServer();
    try {
      const got = await listenWithRetry(probe, '127.0.0.1', busy, 20);
      assert.ok(got > busy && got < busy + 20, `${got} vs ${busy}`);
    } finally {
      probe.close();
      blocker.close();
    }
  });

  it('gives up after the configured number of attempts', async () => {
    const blocker = net.createServer();
    await new Promise<void>((r) => blocker.listen(0, '127.0.0.1', r));
    const busy = (blocker.address() as net.AddressInfo).port;
    try {
      await assert.rejects(listenWithRetry(http.createServer(), '127.0.0.1', busy, 1), /EADDRINUSE/);
    } finally {
      blocker.close();
    }
  });
});

