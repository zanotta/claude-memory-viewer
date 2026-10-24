import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeMemoryIndex, computeIndexWindow } from '../dist/memory-index.js';

const FILES = ['MEMORY.md', 'a.md', 'sub/b.md', 'orphan.md'];

describe('analyzeMemoryIndex', () => {
  it('extracts items with title, target and description', () => {
    const r = analyzeMemoryIndex('- [Alpha](a.md) — First topic\n* [Beta](sub/b.md) - Second\n', FILES);
    assert.equal(r.present, true);
    assert.deepEqual(
      r.items.map((i) => [i.line, i.title, i.resolved, i.description, i.status]),
      [
        [1, 'Alpha', 'a.md', 'First topic', 'ok'],
        [2, 'Beta', 'sub/b.md', 'Second', 'ok'],
      ],
    );
  });

  it('reports broken links and orphan files', () => {
    const r = analyzeMemoryIndex('- [A](a.md) — ok\n- [Gone](gone.md) — missing\n', FILES);
    assert.deepEqual(r.broken.map((i) => i.target), ['gone.md']);
    assert.deepEqual(r.orphans, ['orphan.md', 'sub/b.md']);
  });

  it('resolves ./ prefixes, anchors and percent-encoding', () => {
    const r = analyzeMemoryIndex('- [A](./a.md#top) — x\n- [B](sub/b%2Emd) — y\n', FILES);
    assert.deepEqual(r.items.map((i) => i.status), ['ok', 'ok']);
    assert.deepEqual(r.orphans, ['orphan.md']);
  });

  it('classifies external, outside and non-markdown targets without calling them broken', () => {
    const r = analyzeMemoryIndex(
      '- [Web](https://example.com/x.md) — e\n- [Up](../other.md) — o\n- [Img](pic.png) — n\n- [Anchor](#top) — h\n',
      FILES,
    );
    assert.deepEqual(r.items.map((i) => i.status), ['external', 'outside', 'other', 'other']);
    assert.equal(r.broken.length, 0);
  });

  it('ignores lines that are not index items', () => {
    const r = analyzeMemoryIndex('# Title\n\nSome prose [not](a.md) a list item\n- plain item\n', FILES);
    assert.equal(r.items.length, 0);
  });

  it('copes with CRLF', () => {
    const r = analyzeMemoryIndex('- [A](a.md) — x\r\n- [B](sub/b.md) — y\r\n', FILES);
    assert.equal(r.items.length, 2);
    assert.equal(r.items[0]?.description, 'x');
  });

  it('reports a missing index', () => {
    const r = analyzeMemoryIndex(null, FILES);
    assert.equal(r.present, false);
    assert.deepEqual(r.orphans, []);
  });
});

describe('index window', () => {
  const line = (n: number) => `- [T${n}](a.md) — d`;

  it('everything fits: no cutoff', () => {
    const w = computeIndexWindow([line(1), line(2)].join('\n') + '\n');
    assert.equal(w.cutoffLine, null);
    assert.equal(w.totalLines, 2);
  });

  it('cuts at the line limit', () => {
    const text = Array.from({ length: 10 }, (_, i) => line(i + 1)).join('\n');
    const w = computeIndexWindow(text, { maxLines: 4, maxBytes: 100_000 });
    assert.equal(w.cutoffLine, 5);
    assert.equal(w.totalLines, 10);
  });

  it('cuts at the byte limit, counting UTF-8 bytes', () => {
    // "é" is 2 bytes: each line is 10 + 1 newline = 11 bytes.
    const l = 'éééééééééé'.slice(0, 5) + 'abcde'; // 5*2 + 5 = 15 bytes
    const text = [l, l, l, l].join('\n');
    const w = computeIndexWindow(text, { maxLines: 100, maxBytes: 40 });
    // 16 bytes per line incl. newline: 2 lines = 32 fit, the third would reach 48.
    assert.equal(w.cutoffLine, 3);
  });

  it('marks items beyond the window', () => {
    const text = Array.from({ length: 6 }, (_, i) => line(i + 1)).join('\n');
    const r = analyzeMemoryIndex(text, ['a.md'], { maxLines: 3, maxBytes: 100_000 });
    assert.deepEqual(r.items.map((i) => i.beyondWindow), [false, false, false, true, true, true]);
    assert.equal(r.window?.cutoffLine, 4);
  });

  it('a trailing newline does not count as an extra line', () => {
    const w = computeIndexWindow('a\nb\n', { maxLines: 2, maxBytes: 1000 });
    assert.equal(w.cutoffLine, null);
    assert.equal(w.totalLines, 2);
  });
});
