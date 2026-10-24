import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodeProjectPath } from '../dist/project-path.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/** Static, fictional copy of a Claude config directory (`test/fixtures/claude-home`). */
export function fixtureHome(): string {
  // Compiled tests live in dist-test/, fixtures stay in the source tree.
  return path.resolve(here, '..', 'test', 'fixtures', 'claude-home');
}

export async function makeTempDir(prefix = 'cmv-test-'): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  return { dir, cleanup: () => rm(dir, { recursive: true, force: true }) };
}

export async function write(file: string, content: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

/** Writes a transcript whose third record carries `cwd`, like real ones. */
export function transcriptLines(cwd: string): string {
  return [
    '{"type":"summary","operation":"init","sessionId":"s"}',
    '{"type":"summary","operation":"init2","sessionId":"s"}',
    JSON.stringify({ type: 'user', message: 'hi', cwd, sessionId: 's' }),
  ].join('\n') + '\n';
}

/**
 * Builds `<tmp>/home/.claude/projects/<encoded>/` for a real project folder
 * `<tmp>/work/<name>` and returns the pieces.
 */
export async function makeProject(
  root: string,
  name: string,
  opts: { createProjectDir?: boolean; transcript?: boolean } = {},
): Promise<{ configDir: string; projectPath: string; id: string; memoryDir: string }> {
  const configDir = path.join(root, 'home', '.claude');
  const projectPath = path.join(root, 'work', name);
  const id = encodeProjectPath(projectPath);
  if (opts.createProjectDir !== false) await mkdir(projectPath, { recursive: true });
  const projectDir = path.join(configDir, 'projects', id);
  await mkdir(path.join(projectDir, 'memory'), { recursive: true });
  if (opts.transcript !== false) await write(path.join(projectDir, 's1.jsonl'), transcriptLines(projectPath));
  return { configDir, projectPath, id, memoryDir: path.join(projectDir, 'memory') };
}
