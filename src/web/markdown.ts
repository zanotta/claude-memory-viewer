// A small, dependency-free Markdown renderer. Pure: no DOM, no I/O.
//
// Security model
//   1. The whole input is HTML-escaped before anything else happens, so raw HTML
//      in a document can never reach the output. Every `<` that appears in the
//      result belongs to a tag written in this file.
//   2. Links may only use http, https or mailto, or point at another `.md` file
//      (rendered as in-app navigation via `data-md-link`). Anything else
//      (`javascript:`, `data:`, `vbscript:`, scheme-relative URLs, ...) becomes
//      plain text. Entities cannot smuggle a scheme because `&` is escaped first.
//   3. Images are never loaded (no network requests from the UI): they are shown
//      as a text placeholder, linked when the source is http(s).
//
// Supported: headings, paragraphs, ordered/unordered/nested/task lists, fenced
// code, inline code, bold, italic, strikethrough, blockquotes, horizontal rules,
// GFM tables, links, bare http(s) URLs.
// Not supported on purpose: raw HTML, setext headings, indented code blocks,
// reference-style links, footnotes.

const ESCAPES: Readonly<Record<string, string>> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c] ?? c);
}

function unescapeBasic(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#39);/g, (_m, name: string) => {
    switch (name) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      default:
        return "'";
    }
  });
}

const MAX_DEPTH = 16;
/** Paragraphs longer than this skip the (quadratic-prone) emphasis passes. */
const MAX_EMPHASIS_LENGTH = 20_000;
const MAX_URL_LENGTH = 2000;

// ---------------------------------------------------------------------------
// URLs
// ---------------------------------------------------------------------------

type UrlKind =
  | { kind: 'external'; href: string }
  | { kind: 'internal'; target: string }
  | { kind: 'anchor' }
  | { kind: 'blocked' };

// Whitespace, control characters and line separators. Built from a string because
// compilers may rewrite U+2028/U+2029 escapes inside regex literals into raw characters.
const UNSAFE_URL_CHARS = new RegExp('[\\u0000-\\u0020\\u007f-\\u009f\\u2028\\u2029]');

/** `raw` is already HTML-escaped (it comes from the escaped source). */
function classifyUrl(raw: string): UrlKind {
  const u = unescapeBasic(raw).trim();
  if (!u || u.length > MAX_URL_LENGTH) return { kind: 'blocked' };
  if (UNSAFE_URL_CHARS.test(u)) return { kind: 'blocked' };
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(u);
  if (scheme) {
    const s = (scheme[1] ?? '').toLowerCase();
    return s === 'http' || s === 'https' || s === 'mailto' ? { kind: 'external', href: raw.trim() } : { kind: 'blocked' };
  }
  if (u.startsWith('//') || u.startsWith('\\')) return { kind: 'blocked' };
  if (u.startsWith('#')) return { kind: 'anchor' };
  const pathPart = u.replace(/[?#].*$/, '');
  if (/\.md$/i.test(pathPart)) {
    let decoded = pathPart;
    try {
      decoded = decodeURIComponent(pathPart);
    } catch {
      // keep as written
    }
    return { kind: 'internal', target: escapeHtml(decoded) };
  }
  return { kind: 'blocked' };
}

function linkHtml(destEscaped: string, innerHtml: string): string {
  const k = classifyUrl(destEscaped);
  switch (k.kind) {
    case 'external':
      return `<a href="${k.href}" target="_blank" rel="noopener noreferrer nofollow">${innerHtml}</a>`;
    case 'internal':
      return `<a href="#" class="md-internal" data-md-link="${k.target}">${innerHtml}</a>`;
    case 'anchor':
      return `<span class="md-anchor">${innerHtml}</span>`;
    default:
      return `<span class="md-blocked" title="Link blocked">${innerHtml}</span>`;
  }
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

interface InlineState {
  store: string[];
}

function stash(st: InlineState, html: string): string {
  st.store.push(html);
  return `\u0000${st.store.length - 1}\u0000`;
}

/** Finds the `]` matching the `[` at `open`, or -1. */
function matchBracket(s: string, open: number): number {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (c === '[') depth++;
    else if (c === ']') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

interface ParsedLink {
  end: number;
  text: string;
  dest: string;
}

/** Parses `[text](dest "title")` starting at `s[start] === '['`. */
function parseLink(s: string, start: number): ParsedLink | null {
  const close = matchBracket(s, start);
  if (close < 0 || s[close + 1] !== '(') return null;
  let k = close + 2;
  while (s[k] === ' ') k++;
  let dest: string;
  if (s.startsWith('&lt;', k)) {
    const e = s.indexOf('&gt;', k + 4);
    if (e < 0) return null;
    dest = s.slice(k + 4, e);
    k = e + 4;
  } else {
    const from = k;
    let depth = 0;
    while (k < s.length) {
      const c = s[k];
      if (c === ' ' || c === '\n') break;
      if (c === '(') depth++;
      else if (c === ')') {
        if (depth === 0) break;
        depth--;
      }
      k++;
    }
    dest = s.slice(from, k);
  }
  while (s[k] === ' ' || s[k] === '\n') k++;
  // Optional title in "double" or 'single' quotes (already escaped).
  for (const q of ['&quot;', '&#39;']) {
    if (s.startsWith(q, k)) {
      const e = s.indexOf(q, k + q.length);
      if (e < 0) return null;
      k = e + q.length;
      while (s[k] === ' ' || s[k] === '\n') k++;
      break;
    }
  }
  if (s[k] !== ')') return null;
  return { end: k + 1, text: s.slice(start + 1, close), dest };
}

function trimBareUrl(url: string): string {
  let u = url;
  for (;;) {
    const before = u;
    u = u.replace(/(?:[.,;:!?*~]|&#39;|&quot;)$/, '');
    if (u.endsWith(')') && !u.includes('(')) u = u.slice(0, -1);
    if (u === before) return u;
  }
}

function inlineCore(text: string, st: InlineState, allowLinks: boolean): string {
  let s = text;

  if (allowLinks) {
    let out = '';
    let i = 0;
    while (i < s.length) {
      const c = s[i];
      const isImage = c === '!' && s[i + 1] === '[';
      if (c === '[' || isImage) {
        const open = isImage ? i + 1 : i;
        const link = parseLink(s, open);
        if (link) {
          const inner = inlineCore(link.text, st, false);
          const html = isImage
            ? linkHtml(link.dest, `<span class="md-image">image: ${inner}</span>`)
            : linkHtml(link.dest, inner);
          out += stash(st, html);
          i = link.end;
          continue;
        }
      }
      out += c;
      i++;
    }
    s = out;

    // Bare http(s) URLs.
    s = s.replace(/(^|[\s(>;])(https?:\/\/(?:(?!&lt;|&gt;|&quot;)\S)+)/g, (_m, lead: string, url: string) => {
      const trimmed = trimBareUrl(url);
      const rest = url.slice(trimmed.length);
      const k = classifyUrl(trimmed);
      if (k.kind !== 'external') return `${lead}${url}`;
      return `${lead}${stash(st, linkHtml(trimmed, trimmed))}${rest}`;
    });
  }

  if (s.length <= MAX_EMPHASIS_LENGTH) {
    s = s
      .replace(/\*\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*\*/g, '<strong><em>$1</em></strong>')
      .replace(/\*\*(?=\S)([\s\S]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![A-Za-z0-9_])__(?=\S)([\s\S]+?)(?<=\S)__(?![A-Za-z0-9_])/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\*)(?=\S)([\s\S]+?)(?<=\S)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
      .replace(/(?<![A-Za-z0-9_])_(?=\S)([\s\S]+?)(?<=\S)_(?![A-Za-z0-9_])/g, '<em>$1</em>')
      .replace(/~~(?=\S)([\s\S]+?)(?<=\S)~~/g, '<del>$1</del>');
  }
  return s;
}

/** `text` must already be HTML-escaped. */
function renderInline(text: string): string {
  const st: InlineState = { store: [] };
  let s = text;

  // Code spans first: nothing inside them may be interpreted.
  s = s.replace(/(?<!`)(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g, (_m, _ticks: string, content: string) => {
    let c = content.replace(/\n/g, ' ');
    if (c.length > 2 && c.startsWith(' ') && c.endsWith(' ') && c.trim() !== '') c = c.slice(1, -1);
    return stash(st, `<code>${c}</code>`);
  });
  // Backslash escapes of punctuation (and of the entities produced by escaping).
  s = s.replace(/\\(&(?:amp|lt|gt|quot|#39);|[!#$%()*+,\-./:;=?@[\\\]^_`{|}~])/g, (_m, ch: string) => stash(st, ch));

  s = inlineCore(s, st, true);
  s = s.replace(/(?: {2,}|\\)\n/g, '<br>\n');

  for (let round = 0; round < 8 && s.includes('\u0000'); round++) {
    s = s.replace(/\u0000(\d+)\u0000/g, (_m, n: string) => st.store[Number(n)] ?? '');
  }
  return s.replace(/\u0000/g, '');
}

// ---------------------------------------------------------------------------
// Blocks (operate on escaped lines)
// ---------------------------------------------------------------------------

const FENCE_RE = /^( {0,3})(`{3,}|~{3,})\s*(.*)$/;
const HEADING_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const QUOTE_RE = /^ {0,3}&gt; ?/;
const BULLET_RE = /^( {0,3})([-*+])( +|$)(.*)$/;
const ORDERED_RE = /^( {0,3})(\d{1,9})([.)])( +|$)(.*)$/;
const TABLE_DELIM_RE = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;

const isBlank = (l: string): boolean => l.trim() === '';

/** An opening code fence (a backtick fence cannot carry backticks in its info string). */
function matchFence(line: string): RegExpExecArray | null {
  const m = FENCE_RE.exec(line);
  if (!m) return null;
  if ((m[2] ?? '').startsWith('`') && (m[3] ?? '').includes('`')) return null;
  return m;
}
const indentOf = (l: string): number => l.length - l.trimStart().length;

interface ListMarker {
  indent: number;
  ordered: boolean;
  /** `-`, `*`, `+`, `.` or `)`: items of one list share this. */
  kind: string;
  number: number;
  contentIndent: number;
  rest: string;
}

function parseMarker(line: string): ListMarker | null {
  const b = BULLET_RE.exec(line);
  if (b && !HR_RE.test(line)) {
    const spaces = (b[3] ?? '').length;
    const indent = (b[1] ?? '').length;
    const gap = spaces === 0 || spaces > 4 ? 1 : spaces;
    return {
      indent,
      ordered: false,
      kind: b[2] ?? '-',
      number: 0,
      contentIndent: indent + 1 + gap,
      rest: spaces > 4 ? ' '.repeat(spaces - 1) + (b[4] ?? '') : (b[4] ?? ''),
    };
  }
  const o = ORDERED_RE.exec(line);
  if (o) {
    const spaces = (o[4] ?? '').length;
    const indent = (o[1] ?? '').length;
    const width = (o[2] ?? '').length + 1;
    const gap = spaces === 0 || spaces > 4 ? 1 : spaces;
    return {
      indent,
      ordered: true,
      kind: o[3] ?? '.',
      number: Number(o[2]),
      contentIndent: indent + width + gap,
      rest: spaces > 4 ? ' '.repeat(spaces - 1) + (o[5] ?? '') : (o[5] ?? ''),
    };
  }
  return null;
}

function startsBlock(line: string): boolean {
  if (matchFence(line)) return true;
  if (HEADING_RE.test(line) && /^ {0,3}#/.test(line)) return true;
  if (HR_RE.test(line)) return true;
  if (QUOTE_RE.test(line)) return true;
  const m = parseMarker(line);
  if (m && m.rest.trim() !== '' && (!m.ordered || m.number === 1)) return true;
  return false;
}

function splitCells(line: string): string[] {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|') && !l.endsWith('\\|')) l = l.slice(0, -1);
  const cells: string[] = [];
  let cur = '';
  for (let i = 0; i < l.length; i++) {
    const c = l[i];
    if (c === '\\' && l[i + 1] === '|') {
      cur += '|';
      i++;
    } else if (c === '|') {
      cells.push(cur.trim());
      cur = '';
    } else {
      cur += c;
    }
  }
  cells.push(cur.trim());
  return cells;
}

function renderTable(header: string[], aligns: string[], rows: string[][]): string {
  const cell = (tag: 'th' | 'td', text: string, align: string): string => {
    const cls = align ? ` class="align-${align}"` : '';
    return `<${tag}${cls}>${renderInline(text)}</${tag}>`;
  };
  const head = header.map((h, i) => cell('th', h, aligns[i] ?? '')).join('');
  const body = rows
    .map((r) => `<tr>${header.map((_h, i) => cell('td', r[i] ?? '', aligns[i] ?? '')).join('')}</tr>`)
    .join('\n');
  return `<table>\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
}

function parseBlocks(lines: string[], tight: boolean, depth: number): string {
  const out: string[] = [];
  const paragraph = (text: string): string => (tight ? renderInline(text) : `<p>${renderInline(text)}</p>`);

  if (depth > MAX_DEPTH) {
    const text = lines.map((l) => l.trim()).filter(Boolean).join('\n');
    return text ? paragraph(text) : '';
  }

  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    if (isBlank(line)) {
      i++;
      continue;
    }

    // Fenced code.
    const fence = matchFence(line);
    if (fence) {
      const indent = (fence[1] ?? '').length;
      const marker = fence[2] ?? '```';
      const char = marker[0] ?? '`';
      const lang = ((fence[3] ?? '').trim().split(/\s+/)[0] ?? '').replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 32);
      const body: string[] = [];
      const close = new RegExp(`^ {0,3}${char === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
      const stripIndent = new RegExp(`^ {0,${indent}}`);
      let closed = false;
      i++;
      while (i < lines.length) {
        const l = lines[i] ?? '';
        i++;
        if (close.test(l)) {
          closed = true;
          break;
        }
        body.push(l.replace(stripIndent, ''));
      }
      // An unclosed fence runs to the end of the document; do not keep its trailing blank lines.
      if (!closed) while (body.length && isBlank(body[body.length - 1] ?? '')) body.pop();
      const cls = lang ? ` class="language-${lang}"` : '';
      out.push(`<pre><code${cls}>${body.join('\n')}</code></pre>`);
      continue;
    }

    // ATX heading.
    const h = HEADING_RE.exec(line);
    if (h && /^ {0,3}#/.test(line)) {
      const level = (h[1] ?? '#').length;
      out.push(`<h${level}>${renderInline((h[2] ?? '').trim())}</h${level}>`);
      i++;
      continue;
    }

    if (HR_RE.test(line)) {
      out.push('<hr>');
      i++;
      continue;
    }

    // Blockquote.
    if (QUOTE_RE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const l = lines[i] ?? '';
        if (QUOTE_RE.test(l)) {
          inner.push(l.replace(QUOTE_RE, ''));
        } else if (!isBlank(l) && inner.length && !isBlank(inner[inner.length - 1] ?? '') && !startsBlock(l)) {
          inner.push(l); // lazy continuation
        } else {
          break;
        }
        i++;
      }
      out.push(`<blockquote>\n${parseBlocks(inner, false, depth + 1)}\n</blockquote>`);
      continue;
    }

    // Lists.
    const marker = parseMarker(line);
    if (marker) {
      const result = parseList(lines, i, marker, depth);
      out.push(result.html);
      i = result.next;
      continue;
    }

    // Table.
    const nextLine = lines[i + 1];
    if (line.includes('|') && nextLine !== undefined && TABLE_DELIM_RE.test(nextLine) && nextLine.includes('-')) {
      const header = splitCells(line);
      const delim = splitCells(nextLine);
      if (header.length === delim.length) {
        const aligns = delim.map((d) => {
          const left = d.startsWith(':');
          const right = d.endsWith(':');
          return left && right ? 'center' : right ? 'right' : left ? 'left' : '';
        });
        const rows: string[][] = [];
        i += 2;
        while (i < lines.length && !isBlank(lines[i] ?? '') && (lines[i] ?? '').includes('|')) {
          rows.push(splitCells(lines[i] ?? ''));
          i++;
        }
        out.push(renderTable(header, aligns, rows));
        continue;
      }
    }

    // Paragraph.
    const para: string[] = [line.trimStart()];
    i++;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (isBlank(l) || startsBlock(l)) break;
      para.push(l.trimStart());
      i++;
    }
    out.push(paragraph(para.join('\n').replace(/[ \t]+$/, '')));
  }
  return out.join('\n');
}

function parseList(
  lines: string[],
  start: number,
  first: ListMarker,
  depth: number,
): { html: string; next: number } {
  interface Item {
    lines: string[];
  }
  const items: Item[] = [];
  let loose = false;
  let i = start;

  while (i < lines.length) {
    const m = parseMarker(lines[i] ?? '');
    if (!m || m.ordered !== first.ordered || m.kind !== first.kind || m.indent >= first.indent + 4) break;
    const threshold = Math.min(m.contentIndent, m.indent + 2);
    const content: string[] = [m.rest];
    i++;
    let sawBlankInside = false;
    while (i < lines.length) {
      const l = lines[i] ?? '';
      if (isBlank(l)) {
        // Look ahead: the blank belongs to this item only if indented content follows.
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j] ?? '')) j++;
        if (j < lines.length && indentOf(lines[j] ?? '') >= threshold) {
          for (let k = i; k < j; k++) content.push('');
          sawBlankInside = true;
          i = j;
          continue;
        }
        break;
      }
      if (indentOf(l) >= threshold) {
        content.push(l.slice(Math.min(indentOf(l), m.contentIndent)));
        i++;
        continue;
      }
      const prev = content[content.length - 1] ?? '';
      if (!isBlank(prev) && !startsBlock(l) && !parseMarker(l)) {
        content.push(l.trimStart()); // lazy continuation
        i++;
        continue;
      }
      break;
    }
    if (sawBlankInside) loose = true;
    items.push({ lines: content });

    // Blank lines between items make the list loose.
    let j = i;
    while (j < lines.length && isBlank(lines[j] ?? '')) j++;
    const sibling = j < lines.length ? parseMarker(lines[j] ?? '') : null;
    if (sibling && sibling.ordered === first.ordered && sibling.kind === first.kind && sibling.indent < first.indent + 4) {
      if (j > i) loose = true;
      i = j;
    } else {
      break;
    }
  }

  const tag = first.ordered ? 'ol' : 'ul';
  const startAttr = first.ordered && first.number !== 1 ? ` start="${first.number}"` : '';
  const rendered = items.map((item) => {
    const content = [...item.lines];
    let prefix = '';
    let cls = '';
    const task = /^\[([ xX])\](?: +|$)/.exec(content[0] ?? '');
    if (task) {
      const checked = task[1] !== ' ';
      prefix = `<input type="checkbox" disabled${checked ? ' checked' : ''}> `;
      cls = ' class="task-item"';
      content[0] = (content[0] ?? '').slice(task[0].length);
    }
    const inner = parseBlocks(content, !loose, depth + 1);
    return `<li${cls}>${prefix}${inner}</li>`;
  });
  return { html: `<${tag}${startAttr}>\n${rendered.join('\n')}\n</${tag}>`, next: i };
}

/** Renders Markdown to a safe HTML fragment. */
export function renderMarkdown(src: string): string {
  const normalized = src
    .replace(/^﻿/, '')
    .replace(/\r\n?/g, '\n')
    .replace(/\u0000/g, '�')
    .replace(/^(\t+)/gm, (m) => '    '.repeat(m.length));
  const lines = escapeHtml(normalized).split('\n');
  return parseBlocks(lines, false, 0);
}
