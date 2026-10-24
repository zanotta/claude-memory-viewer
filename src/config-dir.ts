import os from 'node:os';
import path from 'node:path';
import type { ConfigDirInfo } from './shared/types.js';

export interface ConfigDirInputs {
  /** Value of `--config-dir`. */
  flag?: string | undefined;
  /** Value of `CLAUDE_CONFIG_DIR`. */
  env?: string | undefined;
  homedir?: string;
}

export interface ResolvedConfigDir {
  path: string;
  source: ConfigDirInfo['source'];
}

function expandHome(value: string, homedir: string): string {
  if (value === '~') return homedir;
  if (value.startsWith('~/') || value.startsWith('~\\')) return path.join(homedir, value.slice(2));
  return value;
}

/** Precedence: `--config-dir` flag, then `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
export function resolveConfigDir(inputs: ConfigDirInputs = {}): ResolvedConfigDir {
  const homedir = inputs.homedir ?? os.homedir();
  const flag = inputs.flag?.trim();
  if (flag) return { path: path.resolve(expandHome(flag, homedir)), source: 'flag' };
  const env = inputs.env?.trim();
  if (env) return { path: path.resolve(expandHome(env, homedir)), source: 'env' };
  return { path: path.join(homedir, '.claude'), source: 'default' };
}
