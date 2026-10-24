import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import { Scanner } from '../dist/scanner.js';
import { highlightLine, normalizeText, normalizeWithMap, SearchIndex, MAX_RESULTS } from '../dist/search.js';
import { fixtureHome, makeProject, makeTempDir, write } from './helpers.js';
import { startTestServer } from './http-helpers.js';

const text = (segments: { text: string; hit: boolean }[]) => segments.map((s) => s.text).join('');
const hits = (segments: { text: string; hit: boolean }[]) => segments.filter((s) => s.hit).map((s) => s.text);

describe('normalizeText', () => {
  it('removes accents and lower-cases', () => {
    assert.equal(normalizeText('Configuração Ação ÇÃO Não'), 'configuracao acao cao nao'.replace('cao nao', 'cao nao'));
    assert.equal(normalizeText('ÁÉÍÓÚ àèìòù âêîôû ãõ ñ ü'), 'aeiou aeiou aeiou ao n u');
  });

  it('treats precomposed and decomposed forms alike', () => {
    assert.equal(normalizeText('é'), normalizeText('é'));
    assert.equal(normalizeText('é'), 'e');
  });

  it('maps normalized positions back to the original', () => {
    const n = normalizeWithMap('Ação!');
    assert.equal(n.norm, 'acao!');
    assert.deepEqual(n.starts, [0, 1, 2, 3, 4]);
    // decomposed input: the combining mark joins the range of its base letter
    const d = normalizeWithMap('éx');
    assert.equal(d.norm, 'ex');
    assert.deepEqual([d.starts[0], d.ends[0]], [0, 2]);
  });
});

describe('highlightLine', () => {
  it('highlights case- and accent-insensitively without changing the text', () => {
    const seg = highlightLine('Usar variáveis de AMBIENTE, nao commitar', ['variaveis', 'ambiente']);
    assert.equal(text(seg), 'Usar variáveis de AMBIENTE, nao commitar');
    assert.deepEqual(hits(seg), ['variáveis', 'AMBIENTE']);
  });

  it('merges overlapping hits', () => {
    const seg = highlightLine('abcdef', ['abcd', 'cdef']);
    assert.deepEqual(hits(seg), ['abcdef']);
  });

  it('never produces HTML: markup in the text stays plain text', () => {
    const line = '<script>alert(1)</script> and <b>bold</b>';
    const seg = highlightLine(line, ['script']);
    assert.equal(text(seg), line);
    assert.deepEqual(hits(seg), ['script', 'script']);
    for (const s of seg) assert.ok(typeof s.text === 'string' && typeof s.hit === 'boolean');
  });

  it('clips very long lines around the first hit', () => {
    const line = 'x'.repeat(500) + ' needle ' + 'y'.repeat(500);
    const seg = highlightLine(line, ['needle']);
    assert.deepEqual(hits(seg), ['needle']);
    assert.ok(text(seg).length < 300);
    assert.equal(seg[0]?.text, '…');
    assert.equal(seg[seg.length - 1]?.text, '…');
  });
});

describe('SearchIndex', () => {
  it('finds accented text with unaccented queries and vice versa', async () => {
    const idx = new SearchIndex(new Scanner({ configDir: fixtureHome() }));
    for (const q of ['configuracao', 'CONFIGURAÇÃO', 'Configuraçao', 'variaveis de ambiente', 'acao']) {
      const r = await idx.search(q);
      assert.ok(r.results.some((x) => x.path === 'memory/configuracao.md'), `query ${q}`);
    }
    const r = await idx.search('variaveis ambiente');
    const first = r.results[0];
    assert.ok(first);
    assert.equal(first.project, '-home-ana-dev-acentos');
    assert.ok(first.matches.length > 0);
    assert.ok(first.matches.some((m) => m.segments.some((s) => s.hit && /vari[aá]veis/i.test(s.text))));
  });

  it('requires every term, searches the global memory and ignores empty queries', async () => {
    const idx = new SearchIndex(new Scanner({ configDir: fixtureHome() }));
    const g = await idx.search('reviewable commits');
    assert.deepEqual(g.results.map((r) => [r.project, r.path]), [['@global', 'CLAUDE.md']]);
    assert.equal((await idx.search('reviewable zzzzzz')).results.length, 0);
    assert.equal((await idx.search('')).results.length, 0);
    assert.equal((await idx.search('   ')).results.length, 0);
    assert.equal((await idx.search('́')).results.length, 0);
  });

  it('reports line numbers and match counts', async () => {
    const idx = new SearchIndex(new Scanner({ configDir: fixtureHome() }));
    const r = await idx.search('debug');
    const hit = r.results.find((x) => x.path === 'memory/debugging.md');
    assert.ok(hit);
    assert.ok(hit.matchCount >= 2);
    assert.ok(hit.matches.every((m) => m.line >= 1));
  });

  it('is incremental: only changed files are re-read, deletions disappear', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'inc');
      await write(path.join(p.memoryDir, 'a.md'), 'alpha unique-one\n');
      await write(path.join(p.memoryDir, 'b.md'), 'beta\n');
      const idx = new SearchIndex(new Scanner({ configDir: p.configDir }));

      assert.deepEqual(await idx.refresh(), { added: 2, updated: 0, removed: 0, total: 2 });
      assert.deepEqual(await idx.refresh(), { added: 0, updated: 0, removed: 0, total: 2 });
      assert.equal((await idx.search('unique-one')).results.length, 1);

      await write(path.join(p.memoryDir, 'a.md'), 'alpha unique-two and more\n');
      await write(path.join(p.memoryDir, 'c.md'), 'gamma\n');
      await rm(path.join(p.memoryDir, 'b.md'));
      assert.deepEqual(await idx.refresh(), { added: 1, updated: 1, removed: 1, total: 2 });
      assert.equal((await idx.search('unique-one')).results.length, 0);
      assert.equal((await idx.search('unique-two')).results.length, 1);
      assert.equal((await idx.search('beta')).results.length, 0);
      assert.equal((await idx.search('gamma')).results.length, 1);
    } finally {
      await t.cleanup();
    }
  });

  it('caps results at 200 and says so; skips files above the size limit', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'many');
      for (let i = 0; i < MAX_RESULTS + 15; i++) await write(path.join(p.memoryDir, `n${i}.md`), 'common-word\n');
      await write(path.join(p.memoryDir, 'huge.md'), `common-word ${'x'.repeat(2 * 1024 * 1024)}`);
      const idx = new SearchIndex(new Scanner({ configDir: p.configDir }));
      const r = await idx.search('common-word');
      assert.equal(r.results.length, MAX_RESULTS);
      assert.equal(r.truncated, true);
      assert.ok(!r.results.some((x) => x.path === 'memory/huge.md'));
      assert.equal(r.indexed, MAX_RESULTS + 15);
    } finally {
      await t.cleanup();
    }
  });

  it('ranks file-name matches first and includes project-level files', async () => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'rank');
      await write(path.join(p.memoryDir, 'deploy.md'), 'steps\n');
      await write(path.join(p.memoryDir, 'other.md'), 'we deploy on friday\nand deploy again\n');
      await write(path.join(p.projectPath, 'CLAUDE.md'), 'deploy via CI\n');
      const idx = new SearchIndex(new Scanner({ configDir: p.configDir }));
      const r = await idx.search('deploy');
      assert.equal(r.results[0]?.path, 'memory/deploy.md');
      assert.deepEqual(r.results.map((x) => x.path).sort(), ['memory/deploy.md', 'memory/other.md', 'project/CLAUDE.md']);
    } finally {
      await t.cleanup();
    }
  });
});

describe('GET /api/search', () => {
  it('answers with grouped results and highlight segments', async () => {
    const scanner = new Scanner({ configDir: fixtureHome() });
    const s = await startTestServer(fixtureHome(), { search: new SearchIndex(scanner) });
    try {
      const r = await s.get('/api/search?q=' + encodeURIComponent('Variáveis'));
      assert.equal(r.status, 200);
      assert.equal(r.headers['cache-control'], 'no-store');
      const body = r.json() as { results: { path: string; matches: { segments: { text: string; hit: boolean }[] }[] }[] };
      const hit = body.results.find((x) => x.path === 'memory/configuracao.md');
      assert.ok(hit);
      assert.ok(hit.matches[0]?.segments.some((x) => x.hit));
      assert.equal((await s.get('/api/search')).status, 200);
      assert.equal(((await s.get('/api/search?q=' + 'a'.repeat(3000))).json() as { query: string }).query.length, 200);
      assert.equal((await s.get('/api/search?q=' + 'a'.repeat(5000))).status, 414);
    } finally {
      await s.stop();
    }
  });
});
