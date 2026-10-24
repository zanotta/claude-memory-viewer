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

(Filled in per phase.)

## Future work

(Ideas that are out of scope for now.)
