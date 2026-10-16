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

Returns UTF-16 pipe boundaries outside escaped pipes and matching backtick code
spans. Unclosed backtick runs are literal; closing runs must have the same length
as their opening run.
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
matching JavaScript string offsets. A cell's `range` spans its raw boundaries on
the first and last physical lines, including cell-padding whitespace. Its
`segments` locate the separate source pieces that form `value`. Cell `value` is
raw Markdown rather than HTML.

## Writer: `multimd-table/writer`

Named export `stringifyTable(table: WriteTable): string` writes a single table
with LF line endings and no trailing newline. It has no runtime peers and does
not depend on React or an editor. The core `Table` is also structurally assignable
to `WriteTable` when its grid satisfies the writer's validation.

Exported input types:

```ts
interface WriteTable {
  columns: readonly { align: Alignment; wrap?: boolean }[];
  sections: readonly WriteSection[];
  caption?: WriteCaption | null;
}
interface WriteSection { kind: "head" | "body"; rows: readonly WriteRow[] }
interface WriteRow { cells: readonly WriteCell[] }
interface WriteCell {
  column: number;
  colspan?: number; // default 1
  rowspan?: number; // default 1
  value: string;    // Markdown, serialized by the host
  block?: boolean;  // default false
}
interface WriteCaption {
  value: string;
  id?: string | null;
  side: "top" | "bottom";
}
```

`Alignment` is the core `"left" | "center" | "right" | null` type. `wrap` defaults
to false. Every position in every row must be covered exactly once, including
positions inherited from spans. Represent genuine empty cells with `value: ""`;
omit inherited cells from a row's `cells`. Cell order does not matter. Columns,
sections and section rows must be nonempty. A single optional head section must
come first; it may contain multiple rows. Any number of body sections follows.
Row spans stay within their section. Invalid, overlapping, incomplete or
out-of-bounds grids throw `RangeError`, with the section/row/column when relevant.
Input objects are not mutated.

Use `{ rowspan: true, multiline: true, headerless: true, multibody: true }` when
parsing the result. Captions with `id: undefined` use the parser's automatic ID.
Non-null IDs must already be normalized (lowercase ASCII word characters), and
are preserved with `autolabel: true`. An empty ID is supported; when the automatic
ID is nonempty, a non-word label `[!]` represents the explicit empty ID. `id: null` writes an
unlabeled caption and requires `autolabel: false` to retain null. Caption Markdown
must be nonempty, single-line and unambiguous with the optional label syntax.

Content is Markdown rather than plain text. Ordinary literal pipes and `^^` are
escaped, existing escapes retain their meaning, and inline code pipes are kept
inside a single-backtick code span. The writer may normalize the delimiter of a
code span, line endings, hard-break spelling and insignificant whitespace. A
continued row makes **all its cells block cells**, including inline siblings;
one-line block cells receive an empty continuation line. The `block` flag and
exact raw Markdown spelling are therefore not round-trip equality guarantees.
Literal block markers in inline siblings are protected during promotion.
Inline HTML blocks and reference-definition spellings that would change meaning
when promoted are rejected.

MultiMarkdown splits physical lines before interpreting cell Markdown. Some
content cannot be preserved: pipes in fenced/indented code, code spans containing
both pipes and backticks when no single-backtick representation exists, or
significant trailing whitespace in block code or raw HTML, and pipe-bearing
autolinks (serialize these as explicit Markdown links). These cases throw `RangeError`
instead of changing the code. The host owns extension syntax and must serialize
it with table-compatible escaping; the writer cannot infer custom math, HTML,
JSX or plugin-specific escaping rules. Editors can preserve a table's source
locally when serialization throws.

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
