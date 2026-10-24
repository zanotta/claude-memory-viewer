import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function compiledFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...compiledFiles(p));
    else if (e.name.endsWith('.js')) out.push(p);
  }
  return out;
}

const files = compiledFiles(path.join(root, 'dist')).map((f) => ({
  name: path.relative(root, f),
  // Drop comments so the words in them do not count.
  code: readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
}));

describe('static guarantees about the shipped code', () => {
  it('finds the compiled files', () => {
    assert.ok(files.length >= 10);
  });

  it('never uses a filesystem API that can modify anything', () => {
    const forbidden =
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|mkdir|mkdirSync|mkdtemp|rm|rmSync|rmdir|rmdirSync|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|cp|cpSync|createWriteStream|chmod|chown|lchown|symlink|link|truncate|ftruncate|utimes|futimes|lutimes|writeSync|write)\s*\(/;
    for (const f of files) {
      // `res.write(...)` / `.write(` on HTTP responses and streams is not filesystem access.
      const code = f.code.replace(/\b(res|response|process\.(stdout|stderr)|child\.stdin)\.write\s*\(/g, '');
      const hit = forbidden.exec(code.replace(/\.(write|cp|link|rm)\s*\(/g, '.x('));
      assert.equal(hit, null, `${f.name} uses ${hit?.[1]}`);
    }
  });

  it('only ever opens files for reading', () => {
    for (const f of files) {
      for (const m of f.code.matchAll(/\bopen\(([^)]*)\)/g)) {
        const args = m[1] ?? '';
        if (/['"][rwa+x]+['"]/.test(args)) assert.match(args, /['"]r['"]/, `${f.name}: open(${args})`);
      }
    }
  });

  it('makes no outbound network requests', () => {
    const forbidden = /\b(fetch\s*\(|http\.request|https\.request|http\.get|https\.get|node:https|node:net['"]|node:dns|node:tls|XMLHttpRequest|WebSocket|sendBeacon)/;
    for (const f of files) {
      const hit = forbidden.exec(f.code);
      // The browser UI legitimately calls its own origin with fetch().
      if (f.name.startsWith(path.join('dist', 'web'))) {
        assert.doesNotMatch(f.code, /https?:\/\/(?!localhost)[a-z0-9.-]+\.[a-z]{2,}/i, `${f.name} references an external URL`);
        continue;
      }
      assert.equal(hit, null, `${f.name} matches ${hit?.[0]}`);
    }
  });

  it('the web UI only talks to relative URLs', () => {
    for (const f of files.filter((x) => x.name.startsWith(path.join('dist', 'web')))) {
      for (const m of f.code.matchAll(/(?:fetch|EventSource)\(\s*[`'"]([^`'"]+)/g)) {
        assert.match(m[1] ?? '', /^\/(api\/)/, `${f.name}: ${m[0]}`);
      }
    }
  });

  it('the HTML page loads nothing from other origins', () => {
    const html = readFileSync(path.join(root, 'src', 'web', 'index.html'), 'utf8');
    assert.doesNotMatch(html, /(?:src|href)\s*=\s*["'](?:https?:)?\/\//i);
    assert.doesNotMatch(html, /<style|style\s*=|\son[a-z]+\s*=/i);
    const css = readFileSync(path.join(root, 'src', 'web', 'style.css'), 'utf8');
    assert.doesNotMatch(css, /@import|url\(\s*["']?(?:https?:)?\/\//i);
  });

  it('declares no runtime dependencies', () => {
    const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
    assert.equal(pkg['dependencies'], undefined);
    assert.equal(pkg['optionalDependencies'], undefined);
    assert.equal(pkg['peerDependencies'], undefined);
    assert.deepEqual(Object.keys((pkg['devDependencies'] as object) ?? {}).sort(), ['@types/node', 'typescript']);
  });
});
