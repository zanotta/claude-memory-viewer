import type { FrontmatterEntry } from './shared/types.js';

export interface ParsedFrontmatter {
  /** Entries in file order, or null when the file has no (valid) frontmatter. */
  entries: FrontmatterEntry[] | null;
  /** Text after the frontmatter block (the whole input when there is none). */
  body: string;
  /** Number of lines taken by the frontmatter block, including both `---` lines. */
  lineCount: number;
}

const KEY_RE = /^([A-Za-z0-9_][\w .-]*?)\s*:(?:\s+(.*)|\s*)$/;

function unquote(value: string): string {
  const v = value.trim();
  if (v.length >= 2) {
    const first = v[0];
    const last = v[v.length - 1];
    if ((first === '"' || first === "'") && first === last) return v.slice(1, -1);
  }
  return v;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Minimal frontmatter parser: `key: value` lines, plus one level of nesting
 * (a key with an empty value followed by more-indented `key: value` lines)
 * and folded/literal block scalars (`>` / `|`). Anything it does not understand
 * is skipped; it never throws.
 */
export function parseFrontmatter(text: string): ParsedFrontmatter {
  const none: ParsedFrontmatter = { entries: null, body: text, lineCount: 0 };
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const lines = src.split(/\r?\n/);
  if (lines[0]?.trimEnd() !== '---') return none;

  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    const l = (lines[i] ?? '').trimEnd();
    if (l === '---' || l === '...') {
      end = i;
      break;
    }
  }
  if (end < 0) return none;

  const block = lines.slice(1, end);
  const entries: FrontmatterEntry[] = [];
  let i = 0;
  while (i < block.length) {
    const line = block[i] ?? '';
    i++;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    if (indentOf(line) > 0) continue; // stray indented line without a parent key
    const m = KEY_RE.exec(line);
    if (!m) continue;
    const key = (m[1] ?? '').trim();
    const raw = (m[2] ?? '').trim();

    // Gather the more-indented lines that belong to this key.
    const children: string[] = [];
    while (i < block.length) {
      const next = block[i] ?? '';
      if (next.trim() && indentOf(next) === 0) break;
      children.push(next);
      i++;
    }
    while (children.length && !(children[children.length - 1] ?? '').trim()) children.pop();

    if (raw === '' || raw === '>' || raw === '|' || raw === '>-' || raw === '|-') {
      const nested: FrontmatterEntry[] = [];
      const isScalarBlock = raw !== '';
      if (!isScalarBlock) {
        for (const child of children) {
          if (!child.trim() || child.trimStart().startsWith('#')) continue;
          const cm = KEY_RE.exec(child.trim());
          if (cm) nested.push({ key: (cm[1] ?? '').trim(), value: unquote(cm[2] ?? '') });
        }
      }
      if (isScalarBlock) {
        const joiner = raw.startsWith('>') ? ' ' : '\n';
        entries.push({
          key,
          value: children
            .map((c) => c.trim())
            .filter(Boolean)
            .join(joiner),
        });
      } else if (nested.length) {
        entries.push({ key, value: nested });
      } else {
        // `key:` followed by a YAML list ("- item") or nothing.
        const items = children.map((c) => c.trim()).filter((c) => c.startsWith('- '));
        entries.push({ key, value: items.map((c) => unquote(c.slice(2))).join(', ') });
      }
    } else {
      entries.push({ key, value: unquote(raw) });
    }
  }

  const body = lines.slice(end + 1).join('\n');
  return { entries, body, lineCount: end + 1 };
}
