// Copies static web assets next to the compiled frontend and marks the CLI executable.
// Plain Node, no dependencies, works on every platform.
import { chmod, copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = path.join(root, 'src', 'web');
const outDir = path.join(root, 'dist', 'web');
const assets = ['index.html', 'style.css', 'favicon.svg'];

await mkdir(outDir, { recursive: true });
for (const name of assets) {
  await copyFile(path.join(srcDir, name), path.join(outDir, name));
}

const cli = path.join(root, 'dist', 'cli.js');
try {
  await stat(cli);
  await chmod(cli, 0o755);
} catch {
  // Missing on a partial build, or chmod unsupported (Windows): not fatal.
}
console.log(`copied ${assets.length} assets to ${path.relative(root, outDir)}`);
