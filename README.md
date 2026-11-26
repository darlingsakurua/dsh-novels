# dsh-novels

**English** | [简体中文](README.zh-CN.md)

Read `.txt` novels inside DeepSeek Harness: import a file, get chapters split
automatically, and read it in a full panel next to the conversation — or as five
quiet lines under the last message, in the conversation's own typography.

<img width="900" alt="Novel shelf inside DeepSeek Harness" src="docs/shelf.jpg">

Status: **0.1.8** — upload, shelf, reader, progress restore, rename, delete,
reader prefs (font size, line height, page width, inline line count), upload
progress, long-book
table-of-contents grouping, empty/error/loading states, **show or open the folder
that holds your uploaded files**, and an **inline mode** that prints one to five
lines of
the current chapter at the bottom of the conversation instead of taking the whole
centre column.

Features:

- Two ways to read the same book: the **full panel** (shelf + reader) or the
  **inline strip** (one to five lines above the composer, dressed in the transcript's own
  font, size, indent and line height).
- The sidebar 书架 icon opens the full shelf whenever no novel is on screen, and
  only closes the inline strip when one is — it never takes the centre column by
  surprise. The reader's **Inline mode** button hands the open book to the strip
  and returns the centre column to the chat; double-clicking the strip (or its ⤢
  button) brings the full reader back.

- Import `.txt` by button or drag & drop; 20 MB cap, UTF-8/BOM/GB18030/GBK/Big5/UTF-16.
- Automatic chapter split with a 4000-character block fallback.
- Shelf cards show chapter/character counts, encoding, reading progress bar and
  "读到第 N 章"; rename in place; delete with confirmation.
- Storage row above the shelf shows the absolute data folder and opens it; each
  card has a **Location** button that reveals (and selects) that book's `.txt` in
  the OS file manager. The browser cannot do this itself, so the Host spawns
  `explorer.exe /select,…` (Windows), `open -R` (macOS) or `xdg-open` (Linux). The
  client only posts the book id — never a path.
- Uploaded bodies keep the book's name: `books/<title>.txt` (+ `.chapters.json`).
  Renaming a book renames both files, a second book with the same title becomes
  `<title> (2).txt`, and characters Windows forbids (`\ / : * ? " < > |`) are
  replaced before the name touches the disk. Older `<id>.txt` layouts migrate on
  the next start.
- Reader: table of contents, previous/next chapter, font size, line height, page
  width, **inline mode**, keyboard (← → PageUp PageDown Space j k Esc Ctrl±),
  chapter counter and a bottom progress line.
- Inline strip: one to five lines of prose (default five), no title, no buttons, no chapter counter;
  ← → change chapters, ↓/PageUp/PageDown/j/Space move one window forward, ↑/k one
  window back, Esc hides it.
  One key press moves exactly one window (a two-line window advances two lines, a
  one-line window one line) and the position always lands on a line boundary: the
  strip sums the rendered paragraph heights and steps by line index, so a
  paragraph boundary is crossed exactly and no line is shown twice.
  The window itself is a fixed box of exactly N line heights (never measured from
  the prose), and paragraphs carry no vertical margin — only a first-line indent —
  so every line of every paragraph sits on one uniform grid: a short paragraph can
  never leave a blank line inside the window, and scrolling or changing chapters
  cannot resize the strip. It scrolls (the whole chapter stays in the DOM) instead
  of cutting the text, and it reads the newest assistant message's computed
  font/line-height/width/indent so it looks like part of the conversation.
- Reading position (chapter + scroll offset) and reader prefs persist on the Host,
  so they survive a reload and a restart. `/api` ports change every launch, so the
  client keeps no state of its own.
- Long books (>300 chapters) get a grouped table of contents (100-chapter blocks,
  only the active block expanded).

## Screenshots

**Reader** — table of contents, font size / line height / page width controls,
chapter counter, keyboard navigation.

<img width="900" alt="Reader panel" src="docs/reader.jpg">

**Grouped table of contents** — books over 300 chapters are split into blocks of
100, with only the current block expanded.

<img width="900" alt="Grouped table of contents" src="docs/toc.jpg">

## Two ways to read

| | Full panel | Inline strip |
| --- | --- | --- |
| Where | centre column, `main` slot | above the composer, `conversation.input.dock` |
| Size | whole panel | one to five lines (default five), scrollable |
| Enter | 书架 icon, or ⤢ in the strip | **Inline mode** button in the reader toolbar |
| Leave | ← 返回书架 | 书架 icon, Esc, or ⤢ back to the panel |

The strip has no chrome: no title, no toolbar, no chapter number. Its typography is
copied from the newest assistant message (font size, line height, family, colour,
column width, left indent) via `typographyFrom()`, so the prose sits on the
same grid as the surrounding prose.

Hovering the strip reveals five small buttons on its top-right corner: **1–5** set
how many lines are shown. They are shown only while the pointer is over the strip;
focusing it for the keyboard does not pin them over the text. The choice is stored
as `inlineLines` in the reader prefs (`PATCH /prefs`, clamped to 1–5 by the Host),
so it survives a reload and is shared with the reader tab.

The window is a **fixed box**: `inlineStripHeight()` returns exactly
`lines × line box`. Paragraphs have no vertical margin and only a 2em first-line
indent, so a paragraph occupies whole line boxes and the next one starts right
where the previous ended — a one-line paragraph inside a two-line window shows one
line of itself plus one line of the next paragraph, never a blank gap. The height
never depends on what is inside the window, which is why scrolling and chapter
changes no longer resize the strip or shake the page.

`windowLines()` divides that height by the same line box and allows a 5 % slack:
sub-pixel layout used to report one line for an exact two-line box, which made
every key press advance a single line and showed the bottom line twice.

Mouse-wheel scrolling is never realigned: it used to be pulled onto a line top
after the wheel stopped, which read as the page jumping a line.

Both modes share the same Host state: chapter, scroll offset and reader prefs are
written through `PATCH /books/{id}/progress` and `PATCH /prefs`, and the strip
updates its cached book before hiding, so reopening it lands where you left off.
When the strip is opened it picks the book you were last reading (started books
first, then the most recently updated).

## Panel styling

The stylesheet is installed **once into `document.head`** when the plugin
activates (`ensureStyles()`, tag `style[data-plugin-css="dsh-novels/panel.css"]`).

It used to be a `<style>` element rendered inside the shelf's own tree. Every
rule lives in the same string, so the shelf looked right — but opening a book
unmounted the shelf, the style element went with it, and the reader lost the
whole sheet: no `height:100%`, no flex column, no `overflow:auto`. The symptom
was a reader that could not scroll and a chapter footer pushed out of the panel.
Keeping the sheet in `head` makes it independent of whichever view is mounted.
`render.test.mjs` asserts both halves of that contract (sheet in `head`, no
`<style>` inside the panel tree).

The inline strip does not rely on the sheet for its size: `INLINE_BOX_STYLE`
carries the measured `max-height` (one to five line boxes) and `overflow-y: auto`
on the element itself, and the
paragraph spacing is applied as inline styles, so a stale or missing stylesheet
can never let a whole chapter flood the composer area. A runtime probe logs
(`console.error`) if the strip ever measures taller than 200 px.

## Install

```powershell
# clone once, then install from the DSH profile that should carry the plugin
git clone https://github.com/darlingsakurua/dsh-novels.git
plugin_manager install_bundle target="<path-to-your-clone>"
```

The bundle is linked (not copied), so edits under `client/` and `lib/` apply
after the plugin is reloaded (`plugin_manager set_plugin target="include:dsh-novels" enabled=false` then `true`).

## Layout

```
dsh-novels/
  package.json         dsh.bundle.patch + dsh.client (platform: web)
  cordis.patch.yml     inserts the bundle into the profile
  icon.svg             sidebar glyph (currentColor)
  locale/{zh,en}.json  panel title for the sidebar tooltip
  lib/index.mjs        Host half: HTTP routes under /dsh-novels/api/v1
  lib/store.mjs        Host half: library index, atomic writes, path checks
  client/index.mjs     Web half: shelf + reader, plus the text pipeline
```

Data lives in `<profileDir>/plugin-data/dsh-novels/`:

```
library.json            {version, prefs, books[]}
books/<id>.txt          normalized UTF-8 body
books/<id>.chapters.json  [{i, title, start}]
```

## API

All routes are gated exactly like the shipped `/api` channel (the request must
carry the browser session the shell already forwards).

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/ping` | diagnostics (`dataDir`, `bookCount`, version) |
| GET | `/library` | books + reader prefs |
| POST | `/books` | `{name, text, encoding, chapters}` → book |
| GET | `/books/{id}` | book + chapter offsets |
| GET | `/books/{id}/text` | full body as `text/plain` |
| PATCH | `/books/{id}` | rename (`{title, author}`) |
| PATCH | `/books/{id}/progress` | `{chapterIndex, offsetChars, percent}` |
| DELETE | `/books/{id}` | remove book and its files |
| POST | `/reveal` | open the `books/` folder in the OS file manager |
| POST | `/books/{id}/reveal` | reveal + select that book's `.txt` |
| PATCH | `/prefs` | `{fontSize, lineHeight, measure, fontFamily}` |

Envelopes are `{ok: true, ...}` or `{ok: false, error, message}`; request bodies
are capped at 24 MB for uploads and 64 KB for everything else. The client rejects
files over 20 MB before reading them; the Host cap leaves room for the JSON
envelope (body + chapter offsets).

## Text pipeline

`client/index.mjs` decodes bytes in this order: BOM (UTF-8/UTF-16) → strict
UTF-8 → GB18030 → GBK → Big5. Line endings are normalized to `\n` before
chapter offsets are computed, because every offset is a character index into
that normalized text.

Chapter headings are matched with `^第…[章节回卷篇部集]` and
`^Chapter/Part/Book N`. A heading with less than 200 characters before the next
one is treated as a false positive and dropped (the previous chapter absorbs
it); the final chapter is always kept. Files with no heading at all are split
into 4000-character blocks.

Tables of contents above 300 chapters are rendered in blocks of 100 (`1–100`,
`101–200`, …) with only the block holding the current chapter expanded. Grouping
by the first character of the title was tried first and abandoned: nearly every
Chinese chapter heading starts with 第, so it produced a single bucket.

## Tests

No test runner needed — plain Node scripts, each printing `ok`/`FAIL` lines:

```powershell
node _test/store.test.mjs        # Host store: index, atomic writes, clamping
node _test/client-parse.test.mjs # decode/normalize/split (bundled client code)
node _test/host-api.test.mjs     # routes, envelopes, 401/403 gate, limits
node _test/perf.test.mjs         # 5 MB GB18030 sample end to end
node _test/render.test.mjs       # shelf → upload → read → delete → inline strip, headless React
```

`render.test.mjs` loads the real client bundle with a miniature React (hooks +
static tree) and points `fetch` at a server wired to the plugin's own Host
routes, so the browser flow is exercised without a browser. `_test/tmp/`
holds its throwaway profiles. Its last section covers the hybrid behaviour: the
icon opens the full shelf, the reader's inline button moves the same book into the
strip, the icon then only closes the strip.

`_test/make-sample.mjs` regenerates the GB18030 samples in `samples/`
(the 5 MB one is handy for checking upload time by hand).

## Manual acceptance

These cannot be automated from here (the sandbox cannot start a browser):

1. Import `samples/sample-gb18030-small.txt` and `samples/sample-gb18030-5mb.txt`.
2. Read past chapter 10 of the 5 MB book, scroll mid-chapter, go back to the shelf
   — the card should read "读到第 N 章" with a filled bar.
3. Reopen it: same chapter, same scroll offset, same font size/line height/width.
4. Rename a book on the shelf; the reader header follows the new title.
5. Open a book, click **Inline mode**: the panel disappears and the chosen number
   of lines (five by default) appears
   under the last message in the same font/indent, ← → change chapters, ↓ scrolls,
   Esc hides. Hover the strip and click **1–5** to change the height; reload the
   window and it stays. The 书架 icon then only closes the strip; with the strip
   closed it opens the full shelf again.
6. Toggle the app theme (light/dark): all panel surfaces and text follow the
   `--dsw-alias-*` tokens.
7. Disable the plugin (`set_plugin target="include:dsh-novels" enabled=false`):
   the 书架 icon disappears and `/dsh-novels/api/v1/ping` returns 404; re-enable
   and refresh to get it back with the same books.


## Rules this plugin follows

- Never require `@deepseek-ai/dsh-client-*`; only `react` and the builtins.
- Never poke `document.body` or use an iframe; the panel is a React tree in a slot.
  (The stylesheet is a `<style>` in `head`, installed imperatively — like the
  shell's own style service does — not DOM inside the panel.)
- Styles use `--dsw-alias-*` tokens only — no literal colors.
- Keyboard shortcuts live on the reader container, never on `window`.
- The API prefix is `/dsh-novels/api/v1`; `/api` belongs to the connection channel.

## Change log

Every release is summarised here; the README is part of the change, not an
afterthought.

**0.1.8**

- Inline strip line count (1–5) is set from five small buttons on the strip's
  top-right corner. They appear only while the pointer is over the strip: focusing
  it for the keyboard used to pin them over the prose, where they hid the text.
- The strip is a **fixed box** of exactly `lines × line box`. Paragraphs dropped
  their vertical margin (they keep a 2em first-line indent), so every paragraph
  occupies whole line boxes and the next one starts right below: a one-line
  paragraph inside a two-line window shows one line of itself plus one line of the
  next paragraph instead of a blank gap, and scrolling or switching chapters no
  longer resizes the strip or shakes the page.
- One key press moves exactly one window: a two-line window advances two lines
  (it used to advance one, so the previous bottom line was shown again), a
  five-line window advances five. The fixed three-line step is gone.
- `windowLines()` allows a 5 % slack when dividing the height by the line box, so
  an exact two-line window is no longer rounded down to one line.

**0.1.7**

- Inline window height follows the chosen line count instead of a fixed 8.4em.
- Stepping goes by line index, so paragraph boundaries are crossed exactly; the
  mouse wheel is never realigned after it stops.

**0.1.6**

- Full panel and inline strip side by side: the sidebar icon opens the shelf when
  nothing is displayed and only closes the strip when something is; the reader has
  an **Inline mode** button.

**0.1.5**

- Inline strip inside `conversation.input.dock`: five quiet lines, typography
  copied from the newest assistant message, progress written back with the reader.

**0.1.4**

- Stored files are named after the book (`books/<title>.txt`), renaming renames
  both files, duplicates become `<title> (2).txt`, and old `<id>.txt` layouts
  migrate on start.

**0.1.3**

- Storage row and **Location** button: show the data folder, open it, and reveal a
  book's `.txt` in the OS file manager (Host-side, id only from the client).

**0.1.2**

- `/ping` and the startup log report the installed version from `package.json`
  instead of a hard-coded string.

**0.1.1**

- System font for the prose, no bold body text, and chapters whose title line was
  printed twice no longer show it twice.

**0.1.0**

- First release: import, chapter split, shelf, reader, progress restore, rename,
  delete, reader prefs (font size, line height, page width).

## License

[MIT](LICENSE) © 2026 darlingsakurua
