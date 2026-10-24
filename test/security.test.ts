import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isCrossSiteRequest, isHostAllowed, isInside, isLoopbackHost } from '../dist/security.js';

describe('isHostAllowed', () => {
  const policy = { port: 4577, boundHost: '127.0.0.1' };

  it('accepts the loopback names with the current port', () => {
    for (const h of ['localhost:4577', '127.0.0.1:4577', '[::1]:4577', 'LOCALHOST:4577']) {
      assert.equal(isHostAllowed(h, policy), true, h);
    }
  });

  it('rejects other names, wrong ports, missing ports and malformed values', () => {
    for (const h of [
      undefined,
      '',
      'evil.example:4577',
      'localhost.evil.example:4577',
      'localhost:4578',
      'localhost',
      '127.0.0.1:4577@evil.example',
      'localhost:4577/x',
      'user@localhost:4577',
      '192.168.1.5:4577',
      'localhost:4577 evil',
    ]) {
      assert.equal(isHostAllowed(h, policy), false, String(h));
    }
  });

  it('accepts the explicit --host value, and only it', () => {
    const lan = { port: 4577, boundHost: '192.168.1.5' };
    assert.equal(isHostAllowed('192.168.1.5:4577', lan), true);
    assert.equal(isHostAllowed('192.168.1.6:4577', lan), false);
    assert.equal(isHostAllowed('myhost.local:4577', lan), false);
    assert.equal(isHostAllowed('localhost:4577', lan), true);
  });

  it('with a wildcard bind accepts IP literals but never DNS names', () => {
    const any = { port: 4577, boundHost: '0.0.0.0' };
    assert.equal(isHostAllowed('10.0.0.8:4577', any), true);
    assert.equal(isHostAllowed('[fe80::1]:4577', any), true);
    assert.equal(isHostAllowed('rebind.evil.example:4577', any), false);
  });

  it('accepts a bracketed IPv6 --host', () => {
    assert.equal(isHostAllowed('[::1]:4577', { port: 4577, boundHost: '::1' }), true);
  });
});

describe('helpers', () => {
  it('isLoopbackHost', () => {
    for (const h of ['localhost', '127.0.0.1', '127.1.2.3', '::1', '[::1]']) assert.equal(isLoopbackHost(h), true, h);
    for (const h of ['0.0.0.0', '192.168.0.1', 'example.com', '::']) assert.equal(isLoopbackHost(h), false, h);
  });

  it('isCrossSiteRequest only trusts same-origin and direct navigation', () => {
    assert.equal(isCrossSiteRequest({}), false);
    assert.equal(isCrossSiteRequest({ 'sec-fetch-site': 'same-origin' }), false);
    assert.equal(isCrossSiteRequest({ 'sec-fetch-site': 'none' }), false);
    assert.equal(isCrossSiteRequest({ 'sec-fetch-site': 'cross-site' }), true);
    assert.equal(isCrossSiteRequest({ 'sec-fetch-site': 'same-site' }), true);
  });

  it('isInside', async () => {
    const path = await import('node:path');
    const root = path.resolve('/srv/mem');
    assert.equal(isInside(root, path.resolve('/srv/mem')), true);
    assert.equal(isInside(root, path.resolve('/srv/mem/a/b.md')), true);
    assert.equal(isInside(root, path.resolve('/srv/mem/..hidden')), true);
    assert.equal(isInside(root, path.resolve('/srv/mem-other/a.md')), false);
    assert.equal(isInside(root, path.resolve('/srv/a.md')), false);
  });
});
