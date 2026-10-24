# Decisions

Living log of what was verified, what was decided and why. Project names and file
contents from the author's machine are deliberately **not** recorded here; only
structure.

## Phase 0 — Discovery (2026-10-23, macOS, real `~/.claude`)

Method: a throwaway script that reports names, counts, sizes and JSON *keys* only.
It never printed file contents or values.

### Confirmed

| Premise | Result |
| --- | --- |
| Config dir is `~/.claude` | Yes. `CLAUDE_CONFIG_DIR` was unset on the probed machine, so its precedence could not be observed (it is implemented from the documented behaviour). |
| `projects/<encoded>/memory/` holds the auto memory | Yes. 14 of 16 project folders have a `memory/` folder; only 5 of those contain files (13 files in total). The rest are empty folders. |
| `MEMORY.md` is an index with topic files next to it | Yes. Topic files are flat (no sub-folders observed), but the scanner still walks recursively. |
| Folder name = project path with separators replaced by `-` | Yes. For all 16 folders that have a transcript, `cwd.replace(/[^a-zA-Z0-9]/g, "-")` reproduced the folder name exactly. |
| `.jsonl` transcripts live next to `memory/` | Yes, at the top level of each project folder (plus `<uuid>/` sub-folders with session artefacts, which we ignore). They are big: up to ~95 MB, so they must never be read whole. |
| Transcripts carry a `cwd` field | Yes, see the nuances below. |
| Index line format | `- [Title](file.md) — description`, using U+2014 (em dash) in 8 of 8 lines. No headings, no prose lines in any index seen. |
| Topic files may have YAML frontmatter | All 8 topic files have it. `MEMORY.md` has none. |

### Nuances (none contradict the premises materially)

1. **`cwd` is not on the first line.** In the newer transcript format the first two
   records have no `cwd`; it first shows up on line 3. In an older format it is on
   line 1. Individual lines in that prefix reach ~260 KB, so the reader is bounded
   by *bytes* (1 MiB), not only by line count, and ignores a truncated last line.
2. **A project can have more than one distinct `cwd`** (the session `cd`-ed into a
   sub-folder). We therefore only accept a `cwd` whose encoding equals the folder
   name; this also stops a doctored transcript from pointing the tool at an
   arbitrary directory.
3. **Not every project folder has a transcript.** One folder had only `memory/`,
   so the filesystem-search decoder (strategy 2) is required, not optional.
4. **Hyphens are genuinely ambiguous.** Sibling projects whose names differ only
   by a `-suffix` exist on the probed machine. Strategy 2 matches against real
   directory entries instead of guessing separators.
5. **A `cwd` may no longer exist** (1 of 16). Such projects stay visible with the
   "path not found on disk" badge.
6. **Frontmatter has one level of nesting.** Real files look like
   `name:`, `description:`, `metadata:` followed by indented `type:` and a few more
   keys. The parser handles `key: value` plus one nested level.
7. **No global `CLAUDE.md` existed** on the probed machine. Absence is a normal
   state, not an error.
8. Index and topic files are tiny (index 94–752 bytes / 2–5 lines; topics
   0.5–2.9 KB / 13–23 lines), far below the documented 200 line / 25 KB window.
   The window logic is therefore covered by synthetic tests only.

### Not verifiable on this machine

* Encoding of `.`, `_`, spaces and non-ASCII characters: the local corpus only
  contains letters, digits, `/` and `-`. We follow the commonly observed rule
  (every character outside `[A-Za-z0-9]` becomes `-`). If this is wrong,
  strategy 1 (`cwd` from the transcript, validated by re-encoding) simply fails
  to validate and we fall back to strategy 2, which compares against real
  directory names using the same encoder, so the failure mode is "path unknown",
  never "wrong path".
* Very long paths. Some Claude Code versions are reported to truncate the encoded
  name (and append a hash) beyond ~200 characters. We accept a prefix match for
  names longer than 200 characters, but this is untested against real data.
* Windows (`C:\...` → `C--...`) and `CLAUDE_CONFIG_DIR`. Covered with injected-
  filesystem unit tests and CI on Windows, not with real data.

## Design decisions

### Build and layout

* Four TypeScript projects built with `tsc -b`: `src/shared` (types only, never
  loaded at runtime), `src` (server, Node types), `src/web` (browser, DOM lib)
  and `test`. Shared types live in their own project so the browser program does
  not need Node types and the server does not need the DOM lib. This is why
  `types.ts` sits in `src/shared/` instead of `src/`.
* Tests are compiled to `dist-test/` and import the *built* output (`../dist/...`),
  as requested. `scripts/run-tests.mjs` lists the files itself because
  `node --test` does not expand globs on Node 20 or in the Windows shell.
* Argument parsing uses `node:util` `parseArgs` (built in, so still zero runtime
  dependencies). It lives in `args.ts` so tests can import it without starting
  the program; `cli.ts` is a thin entry point that always runs `main()`. (A
  "run only if invoked directly" check breaks when `npx` starts the program via
  a symlink.)

### Project path resolution

* Strategy 1 (transcript `cwd`) is only trusted when the candidate re-encodes to
  the folder name. A doctored or sub-folder `cwd` therefore cannot redirect the
  tool to an arbitrary directory.
* Strategy 2 does not guess separators. It lists each directory on the way and
  keeps entries whose own encoding is a prefix of what is left of the name. That
  handles `-`, `.`, `_`, spaces and anything else in one rule and needs far fewer
  filesystem calls than stat-ing every joiner combination. A read budget (400
  directory listings) bounds the work; ambiguity is reported, not hidden.
* Transcript reads are bounded by bytes (1 MiB, exact), lines (400) and files (the
  5 most recent). Never the whole file.

### Index window

* `MEMORY.md` limits default to 200 lines / 25 KiB (`25 * 1024` bytes), exported as
  constants and overridable through `Scanner` options. The cut is made on a line
  boundary: the first line that would exceed either limit is the first line "not
  loaded into context".

### File access

* Memory files (path chosen by the client): the real path after resolving
  symlinks must stay inside the real memory folder, only `.md`/`.txt`, 2 MB cap,
  NUL bytes rejected.
* Fixed-name files (`<config>/CLAUDE.md`, project `CLAUDE.md`,
  `.claude/CLAUDE.md`, `CLAUDE.local.md`): no client input reaches the path, so a
  symlink to elsewhere is followed (a dotfiles repo is a common setup). The size,
  extension and NUL checks still apply. **This is a deliberate, narrow exception
  to "realpath must stay inside the allowed folder".**

### Server and security

* Order of checks for every request: `Host` header (403) → method (405) → URL
  sanity → route. `Sec-Fetch-Site` other than `same-origin`/`none` is refused on
  `/api/*` as defence in depth (a rebinding-free cross-origin page could still
  fire requests, even though it cannot read the answers: no CORS headers are sent).
* `Host` must carry the actual listening port. With `--host` set to a specific
  address, that address is accepted as well. When binding a wildcard (`0.0.0.0`,
  `::`) only IP literals are accepted besides the loopback names: DNS rebinding
  needs a DNS name, so literals are safe, and it keeps LAN use possible.
* The CSP is the requested `default-src 'self'; frame-ancestors 'none'` plus
  `base-uri 'none'; form-action 'none'`. Because `style-src` falls back to
  `default-src`, the UI must not use inline `style=""` attributes or `<style>`.
* `:id` is always matched against the real directory listing before it touches
  the filesystem. The reserved id `@global` addresses `<config>/CLAUDE.md`.
* File paths in the API are *virtual*: `memory/<rel>` (client chosen, fully
  validated), `project/<fixed name>` and `CLAUDE.md` for the global id (only
  fixed names accepted).
* Static files are served from an allow-list built at start-up (exact URL →
  file), so there is no path to traverse.
* Search results carry highlight segments (`{text, hit}`) instead of an HTML
  string; the UI builds `<mark>` nodes with the DOM API, which is the same
  guarantee as "escape first, mark later" without ever using `innerHTML`.

## Future work

(Ideas that are out of scope for now.)
