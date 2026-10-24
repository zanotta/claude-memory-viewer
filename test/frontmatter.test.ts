import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseFrontmatter } from '../dist/frontmatter.js';

describe('parseFrontmatter', () => {
  it('parses flat key: value pairs and returns the body', () => {
    const r = parseFrontmatter('---\nname: x\ndescription: "Quoted: value"\n---\n# Title\n');
    assert.deepEqual(r.entries, [
      { key: 'name', value: 'x' },
      { key: 'description', value: 'Quoted: value' },
    ]);
    assert.equal(r.body, '# Title\n');
    assert.equal(r.lineCount, 4);
  });

  it('supports one level of nesting', () => {
    const r = parseFrontmatter('---\nname: n\nmetadata:\n  type: user\n  modified: 2026-01-01\nlast: y\n---\nbody');
    assert.deepEqual(r.entries, [
      { key: 'name', value: 'n' },
      {
        key: 'metadata',
        value: [
          { key: 'type', value: 'user' },
          { key: 'modified', value: '2026-01-01' },
        ],
      },
      { key: 'last', value: 'y' },
    ]);
  });

  it('handles CRLF line endings and a BOM', () => {
    const r = parseFrontmatter('﻿---\r\nname: a\r\n---\r\nbody\r\n');
    assert.deepEqual(r.entries, [{ key: 'name', value: 'a' }]);
    assert.equal(r.body, 'body\n');
  });

  it('handles folded and literal block scalars and simple lists', () => {
    const r = parseFrontmatter('---\nsummary: >\n  one\n  two\nraw: |\n  a\n  b\ntags:\n  - x\n  - y\n---\n');
    assert.deepEqual(r.entries, [
      { key: 'summary', value: 'one two' },
      { key: 'raw', value: 'a\nb' },
      { key: 'tags', value: 'x, y' },
    ]);
  });

  it('returns no entries when there is no frontmatter', () => {
    const text = '# Just a heading\n\nBody.\n';
    const r = parseFrontmatter(text);
    assert.equal(r.entries, null);
    assert.equal(r.body, text);
    assert.equal(r.lineCount, 0);
  });

  it('ignores an unterminated block instead of swallowing the document', () => {
    const text = '---\nname: x\n\n# Heading';
    const r = parseFrontmatter(text);
    assert.equal(r.entries, null);
    assert.equal(r.body, text);
  });

  it('skips lines it does not understand and never throws', () => {
    const r = parseFrontmatter('---\n???\n  stray\nok: 1\n# comment\n---\n');
    assert.deepEqual(r.entries, [{ key: 'ok', value: '1' }]);
    assert.doesNotThrow(() => parseFrontmatter('---\n'.repeat(5)));
    assert.doesNotThrow(() => parseFrontmatter(''));
  });
});
