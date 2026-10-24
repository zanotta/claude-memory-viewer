import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeHtml, renderMarkdown } from '../dist/web/markdown.js';

const md = renderMarkdown;

// ---------------------------------------------------------------------------
// Structural safety check: the only `<` in the output may start one of the tags
// below, with attributes from the allow-list and safe values.
// ---------------------------------------------------------------------------
const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'a', 'strong', 'em', 'del', 'code', 'pre',
  'blockquote', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'input', 'span',
]);
const ALLOWED_ATTRS = new Set(['href', 'target', 'rel', 'class', 'data-md-link', 'type', 'disabled', 'checked', 'start', 'title']);
const TAG_RE = /<(\/?)([a-z][a-z0-9]*)((?:\s+[a-z-]+(?:="[^"<>]*")?)*)\s*>/g;

function assertSafe(html: string, label: string): void {
  let leftovers = '';
  let last = 0;
  for (const m of html.matchAll(TAG_RE)) {
    leftovers += html.slice(last, m.index);
    last = (m.index ?? 0) + m[0].length;
    const name = m[2] ?? '';
    assert.ok(ALLOWED_TAGS.has(name), `${label}: tag <${name}> is not allowed in ${html}`);
    for (const a of (m[3] ?? '').matchAll(/\s+([a-z-]+)(?:="([^"]*)")?/g)) {
      const attr = a[1] ?? '';
      const value = a[2] ?? '';
      assert.ok(ALLOWED_ATTRS.has(attr), `${label}: attribute ${attr} is not allowed in ${html}`);
      if (attr === 'href') {
        assert.match(value, /^(https?:|mailto:|#$)/i, `${label}: unsafe href ${value}`);
        assert.doesNotMatch(value, /^(javascript|data|vbscript):/i);
      }
      if (attr === 'target') assert.equal(value, '_blank');
    }
  }
  leftovers += html.slice(last);
  assert.doesNotMatch(leftovers, /[<>]/, `${label}: stray angle bracket in ${html}`);
  assert.doesNotMatch(html, /\u0000/, `${label}: placeholder leaked`);
}

describe('escapeHtml', () => {
  it('escapes the five special characters', () => {
    assert.equal(escapeHtml(`<a href="x">&'</a>`), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;');
  });
});

describe('renderMarkdown: blocks', () => {
  it('renders headings, ignoring invalid ones', () => {
    assert.equal(md('# One'), '<h1>One</h1>');
    assert.equal(md('###### Six ##'), '<h6>Six</h6>');
    assert.equal(md('####### Seven'), '<p>####### Seven</p>');
    assert.equal(md('#hashtag'), '<p>#hashtag</p>');
    assert.equal(md('# C#'), '<h1>C#</h1>');
  });

  it('renders paragraphs with soft and hard breaks', () => {
    assert.equal(md('one\ntwo'), '<p>one\ntwo</p>');
    assert.equal(md('one  \ntwo'), '<p>one<br>\ntwo</p>');
    assert.equal(md('one\\\ntwo'), '<p>one<br>\ntwo</p>');
    assert.equal(md('a\n\nb'), '<p>a</p>\n<p>b</p>');
  });

  it('renders horizontal rules', () => {
    for (const hr of ['---', '***', '___', '- - -']) assert.equal(md(hr), '<hr>', hr);
  });

  it('renders fenced code with a language and escapes its content', () => {
    const html = md('```ts\nconst a = "<b>" && 1;\n```');
    assert.equal(html, '<pre><code class="language-ts">const a = &quot;&lt;b&gt;&quot; &amp;&amp; 1;</code></pre>');
    assert.equal(md('~~~\nx\n~~~'), '<pre><code>x</code></pre>');
  });

  it('does not interpret markdown inside code fences and keeps unclosed ones open', () => {
    assert.equal(md('```\n# not a heading\n*x*\n'), '<pre><code># not a heading\n*x*</code></pre>');
  });

  it('sanitises the fence language', () => {
    const html = md('```js" onclick="alert(1)\nx\n```');
    assertSafe(html, 'lang');
    assert.doesNotMatch(html, /onclick/);
  });

  it('renders blockquotes, including nested ones', () => {
    assert.equal(md('> quoted'), '<blockquote>\n<p>quoted</p>\n</blockquote>');
    const nested = md('> a\n>> b');
    assert.match(nested, /<blockquote>[\s\S]*<blockquote>[\s\S]*<p>b<\/p>/);
  });

  it('renders unordered, ordered and nested lists', () => {
    assert.equal(md('- a\n- b'), '<ul>\n<li>a</li>\n<li>b</li>\n</ul>');
    assert.equal(md('1. a\n2. b'), '<ol>\n<li>a</li>\n<li>b</li>\n</ol>');
    assert.match(md('3. a\n4. b'), /^<ol start="3">/);
    const nested = md('- a\n  - b\n    - c\n- d');
    assert.equal((nested.match(/<ul>/g) ?? []).length, 3);
    assert.match(nested, /<li>a\n<ul>\n<li>b\n<ul>\n<li>c<\/li>/);
  });

  it('nests bullets under an ordered item even with sloppy two-space indentation', () => {
    assert.match(md('1. one\n  - sub'), /<ol>[\s\S]*<ul>[\s\S]*<li>sub<\/li>/);
  });

  it('renders task lists', () => {
    const html = md('- [x] done\n- [ ] todo');
    assert.match(html, /<li class="task-item"><input type="checkbox" disabled checked> done<\/li>/);
    assert.match(html, /<li class="task-item"><input type="checkbox" disabled> todo<\/li>/);
  });

  it('wraps items in paragraphs only for loose lists', () => {
    assert.match(md('- a\n\n- b'), /<li><p>a<\/p><\/li>/);
    assert.match(md('- a\n- b'), /<li>a<\/li>/);
  });

  it('keeps different list kinds apart and lets a list follow a paragraph', () => {
    assert.equal((md('- a\n* b').match(/<ul>/g) ?? []).length, 2);
    assert.match(md('intro\n- a'), /<p>intro<\/p>\n<ul>/);
  });

  it('renders GFM tables with alignment and escaped pipes', () => {
    const html = md('| Name | Qty | Note |\n| :--- | ---: | :---: |\n| a \\| b | 2 | **x** |\n| c | 3 |');
    assert.match(html, /<th class="align-left">Name<\/th><th class="align-right">Qty<\/th><th class="align-center">Note<\/th>/);
    assert.match(html, /<td class="align-left">a \| b<\/td>/);
    assert.match(html, /<td class="align-center"><strong>x<\/strong><\/td>/);
    assert.match(html, /<td class="align-center"><\/td>/); // missing cell is padded
    assertSafe(html, 'table');
  });

  it('does not turn a pipe line without a delimiter row into a table', () => {
    assert.equal(md('a | b\nc | d'), '<p>a | b\nc | d</p>');
  });

  it('handles empty input and whitespace', () => {
    assert.equal(md(''), '');
    assert.equal(md('   \n\n  '), '');
    assert.equal(md('\r\n# T\r\n'), '<h1>T</h1>');
  });
});

describe('renderMarkdown: inline', () => {
  it('renders emphasis', () => {
    assert.equal(md('**b** *i* ***bi*** ~~s~~ __b2__ _i2_'), '<p><strong>b</strong> <em>i</em> <strong><em>bi</em></strong> <del>s</del> <strong>b2</strong> <em>i2</em></p>');
  });

  it('does not misread operators and identifiers', () => {
    assert.equal(md('2 * 3 * 4'), '<p>2 * 3 * 4</p>');
    assert.equal(md('snake_case_name'), '<p>snake_case_name</p>');
    assert.equal(md('a_b_c and x*y*z'), '<p>a_b_c and x<em>y</em>z</p>');
  });

  it('renders inline code without interpreting its content', () => {
    assert.equal(md('`a *b* <c>`'), '<p><code>a *b* &lt;c&gt;</code></p>');
    assert.equal(md('``a`b``'), '<p><code>a`b</code></p>');
    assert.equal(md('`` `x` ``'), '<p><code>`x`</code></p>');
  });

  it('honours backslash escapes', () => {
    assert.equal(md('\\*not italic\\*'), '<p>*not italic*</p>');
    assert.equal(md('\\<b\\>'), '<p>&lt;b&gt;</p>');
  });

  it('renders external links safely', () => {
    const html = md('[site](https://example.com/a?b=1&c=2)');
    assert.equal(html, '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site</a></p>');
    assert.match(md('[mail](mailto:a@b.co)'), /href="mailto:a@b\.co"/);
    assert.match(md('[t](https://e.com "Title")'), /href="https:\/\/e\.com"/);
    assert.match(md('[p](https://en.wikipedia.org/wiki/Foo_(bar))'), /href="https:\/\/en\.wikipedia\.org\/wiki\/Foo_\(bar\)"/);
  });

  it('turns relative .md links into in-app navigation', () => {
    assert.equal(md('[other](sub/other.md)'), '<p><a href="#" class="md-internal" data-md-link="sub/other.md">other</a></p>');
    assert.match(md('[o](./a%20b.md#section)'), /data-md-link="\.\/a b\.md"/);
    assert.match(md('[o](../x.MD)'), /data-md-link="\.\.\/x\.MD"/);
  });

  it('does not link relative non-markdown files or bare anchors', () => {
    assert.doesNotMatch(md('[f](notes.txt)'), /<a /);
    assert.doesNotMatch(md('[f](#top)'), /<a /);
    assert.match(md('[f](#top)'), /md-anchor/);
  });

  it('autolinks bare URLs and trims trailing punctuation', () => {
    assert.equal(md('see https://example.com/x.'), '<p>see <a href="https://example.com/x" target="_blank" rel="noopener noreferrer nofollow">https://example.com/x</a>.</p>');
    assert.match(md('(https://example.com/a)'), /^<p>\(<a href="https:\/\/example\.com\/a"[^>]*>https:\/\/example\.com\/a<\/a>\)<\/p>$/);
    assert.match(md('<https://example.com>'), /<a href="https:\/\/example\.com"/);
  });

  it('never emits <img>: images become a text placeholder', () => {
    const html = md('![logo](https://example.com/x.png) ![local](pic.png)');
    assert.doesNotMatch(html, /<img/i);
    assert.match(html, /image: logo/);
    assert.match(html, /image: local/);
    assertSafe(html, 'image');
  });

  it('handles links with formatting and unmatched brackets', () => {
    assert.match(md('[**bold** `code`](https://e.com)'), /<a [^>]*><strong>bold<\/strong> <code>code<\/code><\/a>/);
    assert.equal(md('[unclosed(https://e.com'), '<p>[unclosed(<a href="https://e.com" target="_blank" rel="noopener noreferrer nofollow">https://e.com</a></p>');
    assert.equal(md('[not a link]'), '<p>[not a link]</p>');
  });
});

// ---------------------------------------------------------------------------
// XSS
// ---------------------------------------------------------------------------
describe('renderMarkdown: XSS', () => {
  const payloads: [string, string][] = [
    ['script tag', '<script>alert(1)</script>'],
    ['img onerror', '<img src=x onerror=alert(1)>'],
    ['svg onload', '<svg/onload=alert(1)>'],
    ['iframe', '<iframe src="javascript:alert(1)"></iframe>'],
    ['javascript link', '[x](javascript:alert(1))'],
    ['javascript link uppercase', '[x](JaVaScRiPt:alert(1))'],
    ['javascript link with tab', '[x](java\tscript:alert(1))'],
    ['javascript link with entity', '[x](javascript&colon;alert(1))'],
    ['javascript link numeric entity', '[x](&#106;avascript:alert(1))'],
    ['javascript link hex entity tab', '[x](jav&#x09;ascript:alert(1))'],
    ['javascript link leading space', '[x]( javascript:alert(1))'],
    ['javascript link control char', '[x](\u0001javascript:alert(1))'],
    ['data link', '[x](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)'],
    ['vbscript link', '[x](vbscript:msgbox(1))'],
    ['file link', '[x](file:///etc/passwd)'],
    ['scheme-relative link', '[x](//evil.example/x)'],
    ['backslash link', '[x](\\\\evil.example\\x)'],
    ['image javascript', '![x](javascript:alert(1))'],
    ['image data', '![x](data:image/svg+xml,<svg onload=alert(1)>)'],
    ['image onerror via alt', '![" onerror="alert(1)](x.png)'],
    ['attribute breakout in href', '[x](https://e.com/" onmouseover="alert(1))'],
    ['attribute breakout with angle', '[x](<https://e.com/" onmouseover="alert(1)>)'],
    ['title breakout', '[x](https://e.com "t" onmouseover="alert(1)")'],
    ['bare url breakout', 'https://e.com/"onmouseover="alert(1)'],
    ['autolink script', '<javascript:alert(1)>'],
    ['code fence breakout', '```"><script>alert(1)</script>\nx\n```'],
    ['inline code breakout', '`</code><script>alert(1)</script>`'],
    ['html in heading', '# <img src=x onerror=alert(1)>'],
    ['html in table', '| <script>alert(1)</script> |\n| --- |\n| <img src=x onerror=alert(1)> |'],
    ['html in list', '- <b onmouseover=alert(1)>x</b>\n- <script>alert(1)</script>'],
    ['html in blockquote', '> <script>alert(1)</script>'],
    ['html comment', '<!-- --><script>alert(1)</script>'],
    ['cdata', '<![CDATA[<script>alert(1)</script>]]>'],
    ['entity smuggling', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['null byte', '<scr\u0000ipt>alert(1)</scr\u0000ipt>'],
    ['placeholder forgery', '\u00000\u0000 \u00001\u0000 `x` \u0000999\u0000'],
    ['unicode line separator in url', '[x](java script:alert(1))'],
    ['task list html', '- [x] <script>alert(1)</script>'],
    ['emphasis wrapping html', '*<script>alert(1)</script>*'],
    ['link text html', '[<img src=x onerror=alert(1)>](https://e.com)'],
  ];

  for (const [label, payload] of payloads) {
    it(`neutralises: ${label}`, () => {
      const html = md(payload);
      assertSafe(html, label);
      assert.doesNotMatch(html, /<script|<img|<iframe|<svg|<\/?b[ >]/i);
      // No anchor may carry a dangerous scheme.
      for (const m of html.matchAll(/href="([^"]*)"/g)) {
        assert.match(m[1] ?? '', /^(https?:|mailto:|#)/i);
      }
    });
  }

  it('shows the dangerous text literally, escaped', () => {
    assert.equal(md('<script>alert(1)</script>'), '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
  });

  it('blocked links keep their text but lose the destination', () => {
    const html = md('[click me](javascript:alert(1))');
    assert.equal(html, '<p><span class="md-blocked" title="Link blocked">click me</span></p>');
  });

  it('survives fuzzed input with only allow-listed markup', () => {
    const tokens = [
      '<script>', '</p>', '`', '``', '*', '**', '_', '__', '~~', '[', '](', ')', ']', 'javascript:', '\n', '\n\n', '> ', '>> ',
      '- ', '* ', '1. ', '2) ', '|', '---', '```', '~~~', '#', '## ', 'a', 'word', ' ', '  ', '\t', '&', '&amp;', '"', "'",
      '![', '<img src=x onerror=alert(1)>', '\\', '&lt;', 'http://x.y/z', 'https://e.com/"', '[x](', '(', '<', '>', '=',
      '- [ ] ', '- [x] ', '\u0000', ':', '//', 'data:', '.md', '#a', '| a | b |\n| - | - |\n',
    ];
    let seed = 1337;
    const rand = (n: number) => {
      seed = (seed * 1664525 + 1013904223) % 4294967296;
      return seed % n;
    };
    for (let i = 0; i < 3000; i++) {
      let s = '';
      const len = 1 + rand(40);
      for (let j = 0; j < len; j++) s += tokens[rand(tokens.length)];
      const html = md(s);
      assertSafe(html, `fuzz#${i} ${JSON.stringify(s)}`);
    }
  });

  it('stays fast on pathological input', () => {
    const inputs = [
      '*a '.repeat(20_000),
      '`'.repeat(50_000),
      '['.repeat(20_000),
      '> '.repeat(5_000) + 'x',
      '- '.repeat(3_000) + 'x',
      '|'.repeat(50_000),
      '**a** '.repeat(20_000),
      '[a](b) '.repeat(10_000),
    ];
    for (const input of inputs) {
      const t = Date.now();
      const html = md(input);
      assert.ok(Date.now() - t < 3000, `took ${Date.now() - t} ms for ${input.slice(0, 12)}`);
      assertSafe(html, 'pathological');
    }
  });
});
