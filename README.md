# claude-memory-viewer

A local, **read-only** viewer for the memories Claude Code keeps on disk: your
`CLAUDE.md` files and the per-project *auto memory*. It starts a small web server
on `localhost` and opens a three-pane interface (projects → files → content) with
search and live updates.

> **Unofficial.** This project is not affiliated with, endorsed by or supported by
> Anthropic. "Claude" and "Claude Code" are trademarks of their owners. The file
> layout it reads is not a documented, stable contract and may change.

[Português (Brasil)](README.pt-BR.md)

<!-- Screenshot placeholder: add docs/screenshot.png and uncomment the next line.
![Claude Memory Viewer](docs/screenshot.png)
-->

## Features

- Browses the global `CLAUDE.md`, every project's auto memory (`MEMORY.md` + topic
  files) and each project's own `CLAUDE.md`, `.claude/CLAUDE.md` and `CLAUDE.local.md`.
- Understands the `MEMORY.md` index: flags **broken links**, **files that are not
  in the index**, and shows exactly where the part that is **not loaded into
  context** begins (200 lines / 25 KB by default).
- Own Markdown renderer (no raw HTML, safe links) with a Raw / Rendered toggle and a
  card for the frontmatter (`name`, `description`, `metadata`, ...).
- Full-text search across everything, case- and accent-insensitive
  (`configuracao` finds `Configuração`).
- Live updates: edit a memory in your editor or let Claude write one, and the page
  refreshes without losing your scroll position or selection.
- Light/dark theme following your system, keyboard navigation, responsive layout.
- Zero runtime dependencies, nothing loaded from the network, nothing written to disk.

## Install and run

Requires **Node.js 20 or newer**.

**With `npx`, straight from GitHub:**

```sh
npx github:zanotta/claude-memory-viewer
```

> **npm 12 and newer** block packages fetched from git by default
> (`EALLOWGIT: Fetching packages of type "git" have been disabled`). Opt in for
> this one command with `npx --allow-git=all github:zanotta/claude-memory-viewer`
> (or use the clone method below, which is unaffected). The first run compiles the
> project from source through its `prepare` script, which takes a few seconds.

**Or clone it:**

```sh
git clone https://github.com/zanotta/claude-memory-viewer.git
cd claude-memory-viewer
npm install        # also builds the project (the "prepare" script)
npm start
```

The browser opens at <http://127.0.0.1:4577/>. Press `Ctrl+C` to stop.

### Options

| Flag | Description | Default |
| --- | --- | --- |
| `--port <n>` | Port to listen on. If it is busy, the next 20 ports are tried. `0` picks a free one. | `4577` |
| `--host <addr>` | Address to bind. Anything other than a loopback address prints a warning. | `127.0.0.1` |
| `--config-dir <dir>` | Claude config directory. Overrides `CLAUDE_CONFIG_DIR` and `~/.claude`. | see below |
| `--no-open` | Do not open the browser. | opens |
| `--json` | Print the scan result (metadata only, no file contents) as JSON and exit. No server. | off |
| `--version`, `--help` | | |

Examples:

```sh
npx github:zanotta/claude-memory-viewer --port 5000 --no-open
npx github:zanotta/claude-memory-viewer --config-dir /path/to/other/.claude
npm start -- --json | jq '.overview.projects[] | {shortName: .shortName, files: .memoryFileCount}'
```

### Keyboard shortcuts

`/` search · `j`/`k` or `↓`/`↑` move in a list · `h`/`l` or `←`/`→` switch pane ·
`r` raw/rendered · `Esc` clear the search.

## Where it looks

1. The config directory: `--config-dir`, else `CLAUDE_CONFIG_DIR`, else `~/.claude`
   (`%USERPROFILE%\.claude` on Windows).
2. `<config>/CLAUDE.md` — global memory.
3. `<config>/projects/<encoded-path>/memory/**/*.md` — auto memory. The folder name
   is the project path with every character other than letters and digits replaced
   by `-`, so it is ambiguous. The real path is recovered by reading the `cwd` field
   from the first few KB of a session transcript, falling back to a search of your
   filesystem. If the project folder is gone, its memory is still shown, with a
   *path not found on disk* badge.
4. For projects whose folder still exists: `CLAUDE.md`, `.claude/CLAUDE.md` and
   `CLAUDE.local.md` inside it (the last one is badged *local only*).

## What it does **not** do

- It never writes, creates, renames or deletes anything. Every non-`GET`/`HEAD`
  request gets `405`.
- It makes no outbound network requests, has no telemetry and loads no fonts,
  scripts or images from anywhere. Images in Markdown are not fetched.
- It does not read your session transcripts (`*.jsonl`) beyond the first
  kilobytes needed to find the project's `cwd`, and it never shows them.
- It does not edit memories, diff versions or export anything.

## Security and privacy

Memories can contain sensitive information, so the defaults are conservative:

- Binds to `127.0.0.1`. Using `--host` with a non-loopback address prints a warning.
- The `Host` header is validated against the loopback names and the actual port,
  which defeats DNS-rebinding attacks. Browser requests labelled cross-site by
  `Sec-Fetch-Site` are refused on the API.
- File access is allow-listed: the project id must be a real folder under
  `projects/`, memory paths are resolved with `realpath` and must stay inside the
  project's `memory/` folder (symlinks that escape are refused), only `.md`/`.txt`
  files up to 2 MB are served, and NUL bytes are rejected. The fixed `CLAUDE.md`
  names (global, project) are the one exception: they may be symlinks, because
  keeping them in a dotfiles repository is common.
- Strict response headers: `Content-Security-Policy: default-src 'self';
  frame-ancestors 'none'` (plus `base-uri`/`form-action 'none'`),
  `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, and
  `Cache-Control: no-store` on the API.
- Markdown is HTML-escaped before anything else; links are limited to `http`,
  `https`, `mailto` and in-app `.md` links.
- Logs contain paths and counts only, never file contents.

## Known limitations

- Claude Code's on-disk format is not a stable contract. Unexpected files never
  crash the viewer; they produce a warning or are skipped.
- The folder-name encoding for `.`, `_`, spaces, non-ASCII characters and Windows
  paths, and the truncation of very long names, are handled from observed
  behaviour and could not all be verified against real data (see `DECISIONS.md`).
- The `MEMORY.md` window (200 lines / 25 KB) follows Claude Code's documentation;
  adjust the constants in `src/memory-index.ts` if that changes.
- The Markdown renderer covers everyday Markdown, not all of CommonMark (no raw
  HTML, setext headings, indented code blocks, reference links or footnotes).
- Changes to project-level `CLAUDE.md` files are picked up by a 5-second poll.

## Troubleshooting

**"No Claude Code config directory found"** — the page shows where it looked.
Point it somewhere else with `--config-dir /path/to/.claude` or set
`CLAUDE_CONFIG_DIR`.

**`EALLOWGIT ... Fetching packages of type "git" have been disabled`** — npm 12+
disables git dependencies by default. Run
`npx --allow-git=all github:zanotta/claude-memory-viewer`, or clone the
repository and use `npm install && npm start`.

**"Port 4577 is in use"** — the viewer already tries the next 20 ports; pass
`--port <n>` to choose another range.

**A project shows only its encoded folder name** — its real path could not be
recovered (no transcript, and the folder no longer exists). Its memory is still
listed.

**The page does not update** — check the indicator at the top right. It says
*reconnecting…* if the event stream dropped; the page resyncs when it returns.

**`npx` seems slow the first time** — it builds the project from source
(`prepare`). Later runs use npm's cache.

## Development

```sh
npm install
npm run build      # tsc -b + copy static assets to dist/
npm test           # compiles the tests and runs them with node:test
npm run clean
```

TypeScript is strict and ESM-only; the server and the browser UI are both
TypeScript with **no runtime dependencies** (only `typescript` and `@types/node`
for development). Tests run against the compiled output with the native test
runner, using a fictional config directory in `test/fixtures/`. See
[DECISIONS.md](DECISIONS.md) for the design notes and findings.

## Contributing

Issues and pull requests are welcome. Please keep changes dependency-free and
read-only, add tests with them, and never commit real memories or transcripts:
fixtures must be fictional.

## License

[MIT](LICENSE)
