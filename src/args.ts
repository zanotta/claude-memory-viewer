import { parseArgs } from 'node:util';

export interface CliOptions {
  port: number;
  host: string;
  configDir: string | undefined;
  open: boolean;
  json: boolean;
  help: boolean;
  version: boolean;
}

export class UsageError extends Error {}

export const HELP = `claude-memory-viewer — read-only viewer for Claude Code memories (unofficial)

Usage: claude-memory-viewer [options]

Options:
  --port <n>          Port to listen on (default 4577; tries the next 20 if busy)
  --host <addr>       Address to bind (default 127.0.0.1)
  --config-dir <dir>  Claude config directory (overrides CLAUDE_CONFIG_DIR and ~/.claude)
  --no-open           Do not open the browser
  --json              Print the scan result as JSON and exit (no server)
  --version           Print the version
  --help              Show this help

Nothing is ever written to your Claude config directory.
`;

export function parseCliArgs(argv: readonly string[]): CliOptions {
  // `npx <pkg> -- --port 1` forwards the literal "--"; accept it.
  const args = argv[0] === '--' ? argv.slice(1) : argv;
  let values;
  try {
    ({ values } = parseArgs({
      args: [...args],
      allowPositionals: false,
      strict: true,
      options: {
        port: { type: 'string' },
        host: { type: 'string' },
        'config-dir': { type: 'string' },
        'no-open': { type: 'boolean', default: false },
        open: { type: 'boolean', default: true },
        json: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new UsageError(msg.replace(/\.$/, '') + '. Run with --help for usage.');
  }

  let port = 4577;
  if (values.port !== undefined) {
    const n = Number(values.port);
    if (!/^\d+$/.test(values.port) || n > 65535) {
      throw new UsageError(`Invalid --port "${values.port}": expected a number between 0 and 65535.`);
    }
    port = n;
  }
  if (values.host !== undefined && values.host.trim() === '') {
    throw new UsageError('--host needs an address.');
  }
  return {
    port,
    host: values.host?.trim() || '127.0.0.1',
    configDir: values['config-dir'],
    open: !values['no-open'] && values.open !== false,
    json: values.json === true,
    help: values.help === true,
    version: values.version === true,
  };
}

