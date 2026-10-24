import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseCliArgs, UsageError } from '../dist/args.js';
import { fixtureHome, makeProject, makeTempDir, write } from './helpers.js';

const cli = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'cli.js');

describe('parseCliArgs', () => {
  it('has sensible defaults', () => {
    assert.deepEqual(parseCliArgs([]), {
      port: 4577,
      host: '127.0.0.1',
      configDir: undefined,
      open: true,
      json: false,
      help: false,
      version: false,
    });
  });

  it('parses every option', () => {
    const o = parseCliArgs(['--port', '9000', '--host=0.0.0.0', '--config-dir', '/x', '--no-open', '--json']);
    assert.equal(o.port, 9000);
    assert.equal(o.host, '0.0.0.0');
    assert.equal(o.configDir, '/x');
    assert.equal(o.open, false);
    assert.equal(o.json, true);
    assert.equal(parseCliArgs(['--version']).version, true);
    assert.equal(parseCliArgs(['-h']).help, true);
  });

  it('turns bad input into usage errors', () => {
    for (const argv of [['--port', 'abc'], ['--port', '70000'], ['--port', '-1'], ['--bogus'], ['stray'], ['--host', ' ']]) {
      assert.throws(() => parseCliArgs(argv), UsageError, argv.join(' '));
    }
  });
});

describe('cli process', () => {
  it('--version and --help exit 0; bad flags exit 2 without a stack trace', () => {
    assert.equal(spawnSync(process.execPath, [cli, '--version']).status, 0);
    assert.match(spawnSync(process.execPath, [cli, '--help']).stdout.toString(), /--config-dir/);
    const bad = spawnSync(process.execPath, [cli, '--nope']);
    assert.equal(bad.status, 2);
    assert.doesNotMatch(bad.stderr.toString(), /\n\s+at /);
  });

  it('--json prints the scan without starting a server', () => {
    const r = spawnSync(process.execPath, [cli, '--json', '--config-dir', fixtureHome()], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout) as { overview: { projects: unknown[] }; details: unknown[] };
    assert.equal(report.overview.projects.length, 4);
    assert.equal(report.details.length, 4);
    // Contents are never part of the report, only metadata.
    assert.doesNotMatch(r.stdout, /Prefer small, reviewable commits/);
  });

  it('--json honours CLAUDE_CONFIG_DIR and reports a missing directory without failing', () => {
    const r = spawnSync(process.execPath, [cli, '--json'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CONFIG_DIR: path.join(fixtureHome(), 'does-not-exist') },
    });
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout) as { overview: { configDir: { exists: boolean; source: string } } };
    assert.equal(report.overview.configDir.exists, false);
    assert.equal(report.overview.configDir.source, 'env');
  });

  it('starts, serves the API and shuts down cleanly on SIGTERM', async (ctx) => {
    const t = await makeTempDir();
    try {
      const p = await makeProject(t.dir, 'smoke');
      await write(path.join(p.memoryDir, 'MEMORY.md'), '- [A](a.md) — a\n');
      await write(path.join(p.memoryDir, 'a.md'), 'A\n');
      const child = spawn(process.execPath, [cli, '--port', '0', '--no-open', '--config-dir', p.configDir], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let out = '';
      child.stdout.on('data', (d: Buffer) => (out += d.toString()));
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`no URL printed: ${out}`)), 10_000);
        child.stdout.on('data', () => {
          const m = /listening:\s+(http:\/\/\S+)/.exec(out);
          if (m?.[1]) {
            clearTimeout(timer);
            resolve(m[1]);
          }
        });
        child.on('exit', () => reject(new Error(`exited early: ${out}`)));
      });
      const res = await fetch(`${url}api/overview`);
      assert.equal(res.status, 200);
      const exited = new Promise<number | null>((resolve) => child.on('exit', (code) => resolve(code)));
      child.kill('SIGTERM');
      const code = await exited;
      if (process.platform === 'win32') ctx.diagnostic('exit code on win32 is not meaningful for SIGTERM');
      else assert.equal(code, 0);
    } finally {
      await t.cleanup();
    }
  });
});
