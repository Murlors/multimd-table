# API reference

`multimd-table` is ESM only. Each entry has TypeScript declarations. Use named
imports from the core and default imports for adapters. Install only the host
and optional peers for the adapter you use.

## Core: `multimd-table`

### `parseTable(source, options?)`

Returns the leading `Table`, or `null` when no table is recognized. Parsing stops
at the first rejected line; this function does not search a whole document.
The host owns outer fences, lists, block quotes, cell interpretation and rendering.

### `expandSection(section)`

Returns a rectangular `(ExpandedCell | null)[][]` grid. Spans fill their covered
positions; holes are `null`. Each slot retains the source cell as `origin` and
marks span copies as `inherited`. Sections are expanded separately. The input
model is not mutated, and expanded slots are independent objects.

Consumers can use `origin` to avoid counting a merged cell multiple times.

### `TableScanner`

Construct `new TableScanner(options?)`. Call `push(line, offset)` with a physical
line without its line ending and its UTF-16 source offset. Rejection returns
`false` without changing state.

`finish()` returns an independent snapshot or `null`. It does not close the
scanner; repeated snapshots and further input are permitted.

| Flag | Meaning |
| --- | --- |
| `committed` | A delimiter has been consumed. |
| `accepted` | A model is available: a delimiter and at least one content row. |
| `finished` | A bottom caption ended the table. |

With `headerless`, a consumed delimiter can be `committed` without being
`accepted` until the first body row arrives.

### `cellBounds(line)`

Returns UTF-16 pipe boundaries under the scanner's escape and backtick rules.
Missing outer pipes use virtual boundaries: `-1` and the trimmed line end.
No valid pipes yields `[]`. Adjacent boundaries delimit raw cell content.

### `defaults` and options

`defaults` is read-only. The core and all adapters accept the same five options:

| Option | Default |
| --- | --- |
| `rowspan` | `false` |
| `multiline` | `false` |
| `headerless` | `false` |
| `multibody` | `true` |
| `autolabel` | `true` |

See the [README](../README.md#syntax) for syntax and option behavior.

### Models and source ranges

Exported types: `Options`, `Table`, `Section`, `Row`, `Cell`, `Caption`, `Range`,
`Alignment`, and `ExpandedCell`. TypeScript declarations document their fields.

All ranges are UTF-16 half-open intervals (`start` inclusive, `end` exclusive),
matching JavaScript string offsets. A multiline cell's `segments` locate its
separate source pieces. Cell `value` is raw Markdown rather than HTML.

## remark: `multimd-table/remark`

The default export is `remarkMultimdTable`, a unified plugin. Place it after
`remarkGfm` when using both. Its runtime peers are `unified` 11 and
`mdast-util-from-markdown` 2; core-only consumers do not need them.

Exported types: `RemarkOptions` (the same core options) and `MultimdNode`.
`MultimdNode` covers table, section, row, cell and caption nodes. A
`multimdTable` retains the core `model`; children contain parsed Markdown, and
`data.hName` / `data.hProperties` describe HTML structure. Nodes retain source
positions.

`remark-rehype` renders these as native table elements. MDX 3 and react-markdown
use this plugin through `remarkPlugins`. Markdown serializers need explicit
support for the custom nodes to preserve merged cells.

## Marked: `multimd-table/marked`

The default export, also available as the named export `markedMultimdTable`, is
`markedMultimdTable(options?)`. It returns a `MarkedExtension` for Marked 18.
Marked 18 requires Node.js 20 or later when used in Node.js.

The exported type `MarkedMultimdTableToken` describes the table token's core
`model`, `cellTokens` and `captionTokens`. Model ranges are relative to the
token's `raw` text after host normalization.

Cell content uses the document lexer and renderer; native extensions and sync
or async `walkTokens` callbacks apply inside cells. Container continuation
follows native Marked table behavior.

## markdown-it: `multimd-table/markdown-it`

The default export is `markdownItMultimdTable(md, options?)`, a plugin for
markdown-it 15. It emits native table and content tokens, preserving renderer
overrides, inline plugins and table enable/disable settings.

With the CommonMark preset, call `.enable("table")` to enable tables.
