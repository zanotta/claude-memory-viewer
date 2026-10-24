import assert from 'node:assert/strict';
import { mkdir, utimes } from 'node:fs/promises';
import path from 'node:path';
import { describe, it } from 'node:test';
import {
  encodedMatches,
  encodeProjectPath,
  ProjectPathResolver,
  readCwdFromTranscripts,
  reconstructProjectPath,
  type DirEntryInfo,
  type FsProbe,
} from '../dist/project-path.js';
import { fixtureHome, makeTempDir, transcriptLines, write } from './helpers.js';

/** Builds an in-memory filesystem from a list of directory paths. */
function fakeFs(dirs: string[], sep: '/' | '\\' = '/'): FsProbe & { reads: number } {
  const children = new Map<string, Set<string>>();
  const add = (parent: string, name: string) => {
    if (!children.has(parent)) children.set(parent, new Set());
    children.get(parent)?.add(name);
  };
  for (const d of dirs) {
    const parts = d.split(sep).filter(Boolean);
    let parent = sep === '/' ? '/' : parts.shift() + '\\';
    for (const part of parts) {
      add(parent, part);
      parent = sep === '/' ? path.posix.join(parent, part) : path.win32.join(parent, part);
    }
  }
  const probe = {
    reads: 0,
    async readdir(dir: string): Promise<DirEntryInfo[] | null> {
      probe.reads++;
      const set = children.get(dir);
      return set ? [...set].map((name) => ({ name, isDirectory: true })) : null;
    },
  };
  return probe;
}

describe('encodeProjectPath', () => {
  it('replaces every non-alphanumeric character with a dash', () => {
    assert.equal(encodeProjectPath('/Users/ana/dev/app'), '-Users-ana-dev-app');
    assert.equal(encodeProjectPath('/a/b-c/d.e/f_g h'), '-a-b-c-d-e-f-g-h');
    assert.equal(encodeProjectPath('C:\\Users\\ana\\dev'), 'C--Users-ana-dev');
  });

  it('matches names that were truncated beyond 200 characters', () => {
    const long = '/' + 'segment/'.repeat(40) + 'end';
    const enc = encodeProjectPath(long);
    assert.ok(enc.length > 200);
    assert.equal(encodedMatches(long, enc.slice(0, 200) + '-abc123'), true);
    assert.equal(encodedMatches('/other/path', enc), false);
  });
});

describe('reconstructProjectPath', () => {
  it('finds a path whose folders contain hyphens', async () => {
    const fs = fakeFs(['/home/ana/dev/my-hyphen-app', '/home/ana/dev/my']);
    const r = await reconstructProjectPath('-home-ana-dev-my-hyphen-app', { platform: 'posix', fs });
    assert.deepEqual(r, { path: '/home/ana/dev/my-hyphen-app', ambiguous: false });
  });

  it('finds folders with spaces, dots and underscores', async () => {
    const fs = fakeFs(['/home/ana/My Projects/web.site/api_v2']);
    const r = await reconstructProjectPath('-home-ana-My-Projects-web-site-api-v2', { platform: 'posix', fs });
    assert.equal(r?.path, '/home/ana/My Projects/web.site/api_v2');
  });

  it('handles hidden folders (a dot after the separator yields a double dash)', async () => {
    const fs = fakeFs(['/home/ana/.config/tool']);
    const r = await reconstructProjectPath('-home-ana--config-tool', { platform: 'posix', fs });
    assert.equal(r?.path, '/home/ana/.config/tool');
  });

  it('prefers the real directory over one that merely shares a prefix', async () => {
    const fs = fakeFs(['/srv/site-3', '/srv/site-3-panel', '/srv/site']);
    assert.equal((await reconstructProjectPath('-srv-site-3', { platform: 'posix', fs }))?.path, '/srv/site-3');
    assert.equal(
      (await reconstructProjectPath('-srv-site-3-panel', { platform: 'posix', fs }))?.path,
      '/srv/site-3-panel',
    );
  });

  it('flags ambiguity when two folders encode to the same name', async () => {
    const fs = fakeFs(['/a/b-c', '/a/b/c']);
    const r = await reconstructProjectPath('-a-b-c', { platform: 'posix', fs });
    assert.ok(r);
    assert.equal(r.ambiguous, true);
  });

  it('backtracks out of a dead end', async () => {
    // "/x/a-b" exists, "/x/a" exists too but has no "b" child.
    const fs = fakeFs(['/x/a/zzz', '/x/a-b']);
    const r = await reconstructProjectPath('-x-a-b', { platform: 'posix', fs });
    assert.equal(r?.path, '/x/a-b');
  });

  it('returns null when nothing matches or the name is malformed', async () => {
    const fs = fakeFs(['/home/ana']);
    assert.equal(await reconstructProjectPath('-home-bob-app', { platform: 'posix', fs }), null);
    assert.equal(await reconstructProjectPath('relative-name', { platform: 'posix', fs }), null);
  });

  it('stops after the configured number of directory reads', async () => {
    const fs = fakeFs(['/a/b/c/d/e']);
    const r = await reconstructProjectPath('-a-b-c-d-e', { platform: 'posix', fs, maxReaddirs: 2 });
    assert.equal(r, null);
    assert.ok(fs.reads <= 2);
  });

  it('understands Windows drive paths', async () => {
    const fs = fakeFs(['C:\\Users\\ana\\dev-tools\\app'], '\\');
    const r = await reconstructProjectPath('C--Users-ana-dev-tools-app', { platform: 'win32', fs });
    assert.equal(r?.path, 'C:\\Users\\ana\\dev-tools\\app');
    assert.equal(await reconstructProjectPath('-Users-ana', { platform: 'win32', fs }), null);
  });

  it('works against the real filesystem', async () => {
    const t = await makeTempDir();
    try {
      const target = path.join(t.dir, 'my-app.v2', 'sub_dir');
      await mkdir(target, { recursive: true });
      const r = await reconstructProjectPath(encodeProjectPath(target));
      assert.equal(r?.path, target);
    } finally {
      await t.cleanup();
    }
  });
});

describe('readCwdFromTranscripts', () => {
  it('reads cwd from the fixture transcript (third record)', async () => {
    const dir = path.join(fixtureHome(), 'projects', '-home-ana-dev-my-hyphen-app');
    assert.equal(await readCwdFromTranscripts(dir, '-home-ana-dev-my-hyphen-app'), '/home/ana/dev/my-hyphen-app');
  });

  it('ignores a cwd that does not encode to the folder name', async () => {
    const t = await makeTempDir();
    try {
      await write(path.join(t.dir, 'a.jsonl'), transcriptLines('/somewhere/else'));
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app'), null);
    } finally {
      await t.cleanup();
    }
  });

  it('skips a sub-folder cwd and keeps looking for the project root', async () => {
    const t = await makeTempDir();
    try {
      const lines = [
        JSON.stringify({ type: 'user', cwd: '/home/ana/app/src' }),
        JSON.stringify({ type: 'user', cwd: '/home/ana/app' }),
      ].join('\n');
      await write(path.join(t.dir, 'a.jsonl'), lines);
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app'), '/home/ana/app');
    } finally {
      await t.cleanup();
    }
  });

  it('tolerates garbage lines and a very long first line', async () => {
    const t = await makeTempDir();
    try {
      const huge = JSON.stringify({ type: 'x', blob: 'z'.repeat(300_000) });
      const content = ['not json', huge, '{"truncated":', JSON.stringify({ cwd: '/home/ana/app' })].join('\n');
      await write(path.join(t.dir, 'a.jsonl'), content);
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app'), '/home/ana/app');
    } finally {
      await t.cleanup();
    }
  });

  it('never reads past the byte cap', async () => {
    const t = await makeTempDir();
    try {
      const filler = JSON.stringify({ blob: 'z'.repeat(1000) }) + '\n';
      const content = filler.repeat(50) + JSON.stringify({ cwd: '/home/ana/app' }) + '\n';
      await write(path.join(t.dir, 'a.jsonl'), content);
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app', { maxBytes: 10_000 }), null);
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app', { maxBytes: 200_000 }), '/home/ana/app');
    } finally {
      await t.cleanup();
    }
  });

  it('tries the newest transcripts first and returns null for an empty folder', async () => {
    const t = await makeTempDir();
    try {
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app'), null);
      await write(path.join(t.dir, 'old.jsonl'), transcriptLines('/nope'));
      await write(path.join(t.dir, 'new.jsonl'), transcriptLines('/home/ana/app'));
      await utimes(path.join(t.dir, 'old.jsonl'), new Date(2020, 1, 1), new Date(2020, 1, 1));
      assert.equal(await readCwdFromTranscripts(t.dir, '-home-ana-app', { maxFiles: 1 }), '/home/ana/app');
      assert.equal(await readCwdFromTranscripts(path.join(t.dir, 'missing'), '-x'), null);
    } finally {
      await t.cleanup();
    }
  });
});

describe('ProjectPathResolver', () => {
  it('uses the transcript first and falls back to the filesystem search', async () => {
    const t = await makeTempDir();
    try {
      const real = path.join(t.dir, 'work', 'no-transcript-app');
      await mkdir(real, { recursive: true });
      const id = encodeProjectPath(real);
      const projectDir = path.join(t.dir, 'cfg', 'projects', id);
      await mkdir(projectDir, { recursive: true });
      const resolver = new ProjectPathResolver();
      assert.deepEqual(await resolver.resolve(projectDir, id), { path: real, source: 'reconstructed' });

      await write(path.join(projectDir, 's.jsonl'), transcriptLines(real));
      resolver.clear();
      assert.deepEqual(await resolver.resolve(projectDir, id), { path: real, source: 'transcript' });
    } finally {
      await t.cleanup();
    }
  });

  it('reports unknown when neither strategy finds the path', async () => {
    const t = await makeTempDir();
    try {
      const r = await new ProjectPathResolver().resolve(t.dir, '-definitely-not-a-real-path-xyz');
      assert.deepEqual(r, { path: null, source: 'unknown' });
    } finally {
      await t.cleanup();
    }
  });
});
