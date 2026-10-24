import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { resolveConfigDir } from '../dist/config-dir.js';

describe('resolveConfigDir', () => {
  const homedir = path.resolve('/home/ana');

  it('prefers the flag over the environment and the default', () => {
    const r = resolveConfigDir({ flag: '/tmp/a', env: '/tmp/b', homedir });
    assert.deepEqual(r, { path: path.resolve('/tmp/a'), source: 'flag' });
  });

  it('uses CLAUDE_CONFIG_DIR when there is no flag', () => {
    const r = resolveConfigDir({ env: '/tmp/b', homedir });
    assert.deepEqual(r, { path: path.resolve('/tmp/b'), source: 'env' });
  });

  it('falls back to ~/.claude', () => {
    const r = resolveConfigDir({ homedir });
    assert.deepEqual(r, { path: path.join(homedir, '.claude'), source: 'default' });
  });

  it('treats empty values as unset and expands ~', () => {
    assert.equal(resolveConfigDir({ flag: '  ', env: '', homedir }).source, 'default');
    assert.equal(resolveConfigDir({ flag: '~/cfg', homedir }).path, path.join(homedir, 'cfg'));
  });
});
