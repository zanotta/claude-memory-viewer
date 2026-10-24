#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { HELP, parseCliArgs, UsageError } from './args.js';
import { resolveConfigDir } from './config-dir.js';
import { Scanner } from './scanner.js';

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

  process.stderr.write('The web server is not implemented yet.\n');
  return EXIT_ERROR;
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
