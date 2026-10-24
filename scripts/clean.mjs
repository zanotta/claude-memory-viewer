import { rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const p of ['dist', 'dist-test', path.join('node_modules', '.cache', 'tsbuild')]) {
  await rm(path.join(root, p), { recursive: true, force: true });
}
