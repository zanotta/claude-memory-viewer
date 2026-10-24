#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseCliArgs, UsageError } from './args.js';
import { resolveConfigDir } from './config-dir.js';
import { Scanner } from './scanner.js';
import { isLoopbackHost } from './security.js';
import { startServer } from './server.js';

const EXIT_OK = 0;
const EXIT_ERROR = 1;
const EXIT_USAGE = 2;

function readVersion(): string {
  try {
    const pkgPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

async function run(argv: readonly string[]): Promise<number> {
  const opts = parseCliArgs(argv);
  if (opts.help) {
    process.stdout.write(HELP);
    return EXIT_OK;
  }
  if (opts.version) {
    process.stdout.write(`${readVersion()}\n`);
    return EXIT_OK;
  }

  const config = resolveConfigDir({ flag: opts.configDir, env: process.env['CLAUDE_CONFIG_DIR'] });
  const scanner = new Scanner({ configDir: config.path, configSource: config.source });

  if (opts.json) {
    const report = await scanner.fullReport();
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return EXIT_OK;
  }

  const webDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'web');
  let running;
  try {
    running = await startServer({ scanner, host: opts.host, port: opts.port, webDir });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `Port ${opts.port} is in use (and the next 19 ports too). Pick another one with --port <n>.`,
      );
    }
    if (code === 'EACCES') throw new Error(`Not allowed to listen on port ${opts.port}. Try --port 4577.`);
    if (code === 'EADDRNOTAVAIL' || code === 'ENOTFOUND') {
      throw new Error(`Cannot bind to "${opts.host}": address not available on this machine.`);
    }
    throw err;
  }

  const hostForUrl = opts.host.includes(':') && !opts.host.startsWith('[') ? `[${opts.host}]` : opts.host;
  const urlHost = ['0.0.0.0', '::', '[::]'].includes(opts.host) ? 'localhost' : hostForUrl;
  const url = `http://${urlHost}:${running.port}/`;
  const overview = await scanner.overview();

  if (!isLoopbackHost(opts.host)) {
    process.stderr.write(
      `Warning: listening on ${opts.host}, which other machines may be able to reach. ` +
        `Memories can contain sensitive information. Use the default 127.0.0.1 unless you are sure.\n`,
    );
  }
  if (!overview.configDir.exists) {
    process.stderr.write(`Warning: config directory not found: ${config.path} (use --config-dir <dir>).\n`);
  }
  process.stdout.write(
    `claude-memory-viewer ${readVersion()} (unofficial, read-only)\n` +
      `  config dir: ${config.path}\n` +
      `  projects:   ${overview.projects.length}\n` +
      `  listening:  ${url}\n` +
      `Press Ctrl+C to stop.\n`,
  );
  if (opts.open) openBrowser(url);

  await new Promise<void>((resolve) => {
    let closing = false;
    const shutdown = (): void => {
      if (closing) return;
      closing = true;
      void running.close().then(resolve);
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
  return EXIT_OK;
}

/** Best effort: failing to open a browser is never fatal. */
function openBrowser(url: string): void {
  let command: string;
  let args: string[];
  if (process.platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
      windowsVerbatimArguments: process.platform === 'win32',
    });
    child.on('error', () => {
      process.stderr.write(`Could not open a browser automatically. Open ${url} manually.\n`);
    });
    child.unref();
  } catch {
    process.stderr.write(`Could not open a browser automatically. Open ${url} manually.\n`);
  }
}

async function main(): Promise<void> {
  try {
    process.exitCode = await run(process.argv.slice(2));
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`Error: ${err.message}\n`);
      process.exitCode = EXIT_USAGE;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`Error: ${message}\n`);
    if (process.env['DEBUG'] === '1' && err instanceof Error && err.stack) {
      process.stderr.write(`${err.stack}\n`);
    }
    process.exitCode = EXIT_ERROR;
  }
}

void main();
