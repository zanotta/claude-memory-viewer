import assert from 'node:assert/strict';
import { mkdir, readdir, stat, symlink } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Scanner } from '../dist/scanner.js';
import { fixtureHome, makeProject, makeTempDir, write } from './helpers.js';

const badgeIds = (b: { id: string }[]) => b.map((x) => x.id);

async function snapshot(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string): Promise<void> => {
    for (const e of await readdir(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${(await stat(p)).mtimeMs}:${(await stat(p)).size}`);
    }
  };
  await walk(dir);
  return out.sort();
}

describe('Scanner (fixture tree)', () => {
  const scanner = new Scanner({ configDir: fixtureHome() });

  it('lists projects, global memory and config info', async () => {
    const o = await scanner.overview();
    assert.equal(o.configDir.exists, true);
    assert.equal(o.global.exists, true);
    assert.equal(o.global.entry?.path, 'CLAUDE.md');
    assert.deepEqual(
      o.projects.map((p) => p.id).sort(),
      [
        '-home-ana-dev-acentos',
        '-home-ana-dev-app',
        '-home-ana-dev-my-hyphen-app',
        '-home-ana-dev-no-transcript',
      ],
    );
  });

  it('analyses a project: files, index, badges', async () => {
    const d = await scanner.project('-home-ana-dev-app');
    assert.ok(d);
    assert.equal(d.summary.realPath, '/home/ana/dev/app');
    assert.equal(d.summary.pathSource, 'transcript');
    assert.equal(d.summary.pathExists, false);
    assert.deepEqual(badgeIds(d.summary.badges), ['path-not-found']);
    assert.equal(d.summary.projectFileCount, 0);

    // MEMORY.md first; non-.md files are not listed.
    assert.deepEqual(d.files.map((f) => f.path), [
      'memory/MEMORY.md',
      'memory/debugging.md',
      'memory/orphan.md',
      'memory/sub/nested.md',
    ]);
    const byPath = new Map(d.files.map((f) => [f.path, f]));
    assert.deepEqual(badgeIds(byPath.get('memory/MEMORY.md')?.badges ?? []), ['broken-link']);
    assert.deepEqual(badgeIds(byPath.get('memory/orphan.md')?.badges ?? []), ['not-in-index']);
    assert.deepEqual(badgeIds(byPath.get('memory/debugging.md')?.badges ?? []), []);
    assert.deepEqual(d.index.broken.map((i) => i.target), ['missing.md']);
    assert.deepEqual(d.index.orphans, ['orphan.md']);
    assert.equal(byPath.get('memory/MEMORY.md')?.lines, 4);
  });

  it('resolves a project without any transcript through the filesystem search', async () => {
    const d = await scanner.project('-home-ana-dev-no-transcript');
    assert.ok(d);
    assert.equal(d.summary.pathSource === 'unknown' || d.summary.pathSource === 'reconstructed', true);
    assert.equal(d.summary.memoryFileCount, 2);
    assert.deepEqual(d.index.orphans, []);
  });

  it('returns null for an unknown project id', async () => {
    assert.equal(await scanner.project('-nope'), null);
    assert.equal(await scanner.project('../..'), null);
  });

  it('reads a file with frontmatter', async () => {
    const r = await scanner.readFile('-home-ana-dev-app', 'memory/debugging.md');
    assert.ok(r.ok);
    assert.equal(r.content.frontmatter?.[0]?.key, 'name');
    assert.equal(r.content.bodyStartLine, 8);
    assert.equal(r.content.indexWindow, null);
  });

  it('attaches the loaded-window info to MEMORY.md', async () => {
    const r = await scanner.readFile('-home-ana-dev-app', 'memory/MEMORY.md');
    assert.ok(r.ok);
    assert.equal(r.content.indexWindow?.cutoffLine, null);
    assert.equal(r.content.indexWindow?.totalLines, 4);
  });
});

describe('Scanner (temporary trees)', () => {
  it('lists project-level CLAUDE files and flags CLAUDE.local.md', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'my-app');
      await write(path.join(p.projectPath, 'CLAUDE.md'), '# Project\n');
      await write(path.join(p.projectPath, '.claude', 'CLAUDE.md'), '# Dot\n');
      await write(path.join(p.projectPath, 'CLAUDE.local.md'), '# Mine\n');
      await write(path.join(p.memoryDir, 'MEMORY.md'), '- [A](a.md) — a\n');
      await write(path.join(p.memoryDir, 'a.md'), 'A\n');

      const d = await new Scanner({ configDir: p.configDir }).project(p.id);
      assert.ok(d);
      assert.equal(d.summary.pathExists, true);
      assert.equal(d.summary.projectFileCount, 3);
      assert.equal(d.summary.memoryFileCount, 2);
      const local = d.files.find((f) => f.path === 'project/CLAUDE.local.md');
      assert.deepEqual(badgeIds(local?.badges ?? []), ['local-only']);
      assert.deepEqual(
        d.files.filter((f) => f.scope === 'project').map((f) => f.path),
        ['project/CLAUDE.md', 'project/.claude/CLAUDE.md', 'project/CLAUDE.local.md'],
      );
    } finally {
      await t.cleanup();
    }
  });

  it('keeps showing memory for a project whose folder is gone', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'deleted-app', { createProjectDir: false });
      await write(path.join(p.memoryDir, 'MEMORY.md'), '# Still here\n');
      const d = await new Scanner({ configDir: p.configDir }).project(p.id);
      assert.ok(d);
      assert.deepEqual(badgeIds(d.summary.badges), ['path-not-found']);
      assert.equal(d.summary.memoryFileCount, 1);
      assert.equal(d.summary.projectFileCount, 0);
    } finally {
      await t.cleanup();
    }
  });

  it('flags topics that are only referenced beyond the loaded window', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'big-index');
      const filler = Array.from({ length: 5 }, (_, i) => `- [F${i}](f${i}.md) — filler`).join('\n');
      await write(path.join(p.memoryDir, 'MEMORY.md'), `${filler}\n- [Late](late.md) — late entry\n`);
      for (const n of ['f0', 'f1', 'f2', 'f3', 'f4', 'late']) await write(path.join(p.memoryDir, `${n}.md`), n);
      const scanner = new Scanner({ configDir: p.configDir, limits: { indexMaxLines: 5 } });
      const d = await scanner.project(p.id);
      assert.ok(d);
      const byPath = new Map(d.files.map((f) => [f.path, badgeIds(f.badges)]));
      assert.deepEqual(byPath.get('memory/MEMORY.md'), ['beyond-window']);
      assert.deepEqual(byPath.get('memory/late.md'), ['beyond-window']);
      assert.deepEqual(byPath.get('memory/f0.md'), []);
    } finally {
      await t.cleanup();
    }
  });

  it('never throws on odd content and reports a warning for a missing index', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'odd');
      await write(path.join(p.memoryDir, 'topic.md'), '\u0000\u0001 binary-ish ---\n');
      await write(path.join(p.memoryDir, 'empty.md'), '');
      const d = await new Scanner({ configDir: p.configDir }).project(p.id);
      assert.ok(d);
      assert.equal(d.summary.memoryFileCount, 2);
      assert.equal(d.index.present, false);
      assert.ok(d.warnings.some((w) => /no MEMORY\.md/.test(w)));
      assert.equal(d.files.find((f) => f.name === 'empty.md')?.lines, 0);
    } finally {
      await t.cleanup();
    }
  });

  it('copes with a missing config directory', async () => {
    const t = await makeTempDir();
    try {
      const o = await new Scanner({ configDir: path.join(t.dir, 'nope') }).overview();
      assert.equal(o.configDir.exists, false);
      assert.deepEqual(o.projects, []);
      assert.equal(o.global.exists, false);
      assert.ok(o.warnings[0]?.includes('nope'));
    } finally {
      await t.cleanup();
    }
  });

  it('does not list symlinks that point outside the memory folder', async (ctx) => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'links');
      await write(path.join(t.dir, 'outside.md'), 'outside\n');
      try {
        await symlink(path.join(t.dir, 'outside.md'), path.join(p.memoryDir, 'escape.md'));
      } catch {
        ctx.skip('symlinks are not available on this system');
        return;
      }
      await write(path.join(p.memoryDir, 'ok.md'), 'ok\n');
      const d = await new Scanner({ configDir: p.configDir }).project(p.id);
      assert.deepEqual(d?.files.map((f) => f.name), ['ok.md']);
      assert.ok(d?.warnings.some((w) => /outside the memory folder/.test(w)));
    } finally {
      await t.cleanup();
    }
  });

  it('is read-only: scanning leaves the tree untouched', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'readonly');
      await write(path.join(p.memoryDir, 'MEMORY.md'), '- [A](a.md) — a\n');
      await write(path.join(p.memoryDir, 'a.md'), 'A\n');
      await mkdir(path.join(p.memoryDir, 'empty-dir'));
      const before = await snapshot(t.dir);
      const scanner = new Scanner({ configDir: p.configDir });
      await scanner.fullReport();
      await scanner.readFile(p.id, 'memory/a.md');
      assert.deepEqual(await snapshot(t.dir), before);
    } finally {
      await t.cleanup();
    }
  });
});
