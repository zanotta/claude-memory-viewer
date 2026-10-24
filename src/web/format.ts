export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

export function relativeTime(ms: number, now: number = Date.now()): string {
  const seconds = Math.round((ms - now) / 1000);
  const abs = Math.abs(seconds);
  if (abs < 45) return 'just now';
  if (abs < 45 * 60) return rtf.format(Math.round(seconds / 60), 'minute');
  if (abs < 22 * 3600) return rtf.format(Math.round(seconds / 3600), 'hour');
  if (abs < 26 * 86400) return rtf.format(Math.round(seconds / 86400), 'day');
  if (abs < 320 * 86400) return rtf.format(Math.round(seconds / (30 * 86400)), 'month');
  return rtf.format(Math.round(seconds / (365 * 86400)), 'year');
}

export function absoluteTime(ms: number): string {
  return new Date(ms).toLocaleString();
}

export function plural(n: number, one: string, many: string = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Resolves `target` against the directory of `fromPath`, POSIX style. Null when it escapes. */
export function resolveRelative(fromPath: string, target: string): string | null {
  const base = fromPath.split('/').slice(0, -1);
  const parts = [...base];
  for (const seg of target.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else {
      parts.push(seg);
    }
  }
  return parts.join('/');
}
