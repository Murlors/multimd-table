# API reference

`multimd-table` is ESM only. Each entry has TypeScript declarations. Use named
imports from the core and default imports for adapters. Install only the host
and optional peers for the adapter you use.

The package loads its included Rust/WASM file during the ESM import, using
top-level `await`. Public calls remain synchronous after initialization. Runtime support and
first-import initialization are described in the [runtime and bundler notes](#runtime-and-bundlers).

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

The offset and `offset + line.length` must be nonnegative safe integers. Large
document offsets, gaps and repeated offsets are preserved; the binding maps them
to compact table-local positions internally. Invalid offsets throw `RangeError`.

`finish()` returns an independent snapshot or `null`. It does not close the
scanner; repeated snapshots and further input are permitted.

Call `dispose()` in `finally` after the last use. Disposal is idempotent, releases
the native scanner and retained source lines, and leaves previous models intact.
Further `push` or `finish` calls throw. The adapters handle this lifetime for
their own scanners; direct users must not depend on garbage collection for timely
release of WASM memory.

| Flag        | Meaning                                                         |
| ----------- | --------------------------------------------------------------- |
| `committed` | A delimiter has been consumed.                                  |
| `accepted`  | A model is available: a delimiter and at least one content row. |
| `finished`  | A bottom caption ended the table.                               |

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

| Option       | Default |
| ------------ | ------- |
| `rowspan`    | `false` |
| `multiline`  | `false` |
| `headerless` | `false` |
| `multibody`  | `true`  |
| `autolabel`  | `true`  |

See the [syntax reference](#syntax) for syntax and option behavior.

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
interface WriteSection {
  kind: "head" | "body";
  rows: readonly WriteRow[];
}
interface WriteRow {
  cells: readonly WriteCell[];
}
interface WriteCell {
  column: number;
  colspan?: number; // default 1
  rowspan?: number; // default 1
  value: string; // Markdown, serialized by the host
  block?: boolean; // default false
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

## Installation and peers

Install `multimd-table` first, then the host and peers for your chosen adapter.
The core and writer have no external JavaScript runtime peers.

| Entry                       | Host / peers                                |
| --------------------------- | ------------------------------------------- |
| `multimd-table`             | None at runtime                             |
| `multimd-table/writer`      | None at runtime                             |
| `multimd-table/remark`      | `unified` 11, `mdast-util-from-markdown` 2  |
| `multimd-table/marked`      | `marked` 18 (Node.js 20+ when used in Node) |
| `multimd-table/markdown-it` | `markdown-it` 15                            |

## Runtime and bundlers

Node and Bun read the file from the installed package. Browsers and module Workers
load it relative to the JavaScript module; serve the complete package or let an
asset-aware bundler such as Vite handle the URL. A bundler may emit the WASM as a
separate resource or inline it in its output; both forms are supported. The npm
package itself contains one binary, with no Base64 copy.

Module initialization uses top-level `await`, so bundled output must support
ES2022 modules. With Vite Workers, use `worker: { format: "es" }`. For Node SSR,
keep `multimd-table` external, as Vite does by default: the installed package
owns its WASM resource. Bundlers that do not process `new URL(..., import.meta.url)`
assets must preserve the module-relative file layout; arbitrary fully bundled SSR,
classic Workers and edge runtimes are not covered by this loading path.

Initialization has a cost separate from parsing throughput. Browsers and Workers
need WebAssembly support and permission to fetch the same-origin WASM resource.
Apps with CSP must allow WASM compilation, for example with `wasm-unsafe-eval` in
`script-src` ([WebAssembly compilation and CSP](https://developer.mozilla.org/en-US/docs/WebAssembly/Reference/JavaScript_interface/Module/Module)).
When bundling remark in a Web Worker, select the `worker` export condition so its
entity decoder uses the document-free implementation.

## Integration examples

## react-markdown

```sh
bun add react react-dom react-markdown remark-gfm unified mdast-util-from-markdown
```

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

const source = `
| Feature | Included |
| ------- | -------- |
| Merged across both columns ||
| ^^ ||
`;

<ReactMarkdown remarkPlugins={[remarkGfm, [remarkMultimdTable, { rowspan: true }]]}>
  {source}
</ReactMarkdown>;
```

Place this plugin **after `remarkGfm`** when using both. GFM is optional and
supplies features such as strikethrough and footnotes. `rehype-raw` is not
required for these tables.

## remark / unified

```sh
bun add unified remark-parse remark-gfm remark-rehype rehype-stringify mdast-util-from-markdown
```

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkMultimdTable from "multimd-table/remark";

const html = String(
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMultimdTable, { rowspan: true })
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync("A|B\n-|-\nmerged||\n^^||"),
);
```

## Marked

```sh
bun add marked
```

```ts
import { Marked } from "marked";
import markedMultimdTable from "multimd-table/marked";

const parser = new Marked(markedMultimdTable({ rowspan: true, multiline: true }));
const html = parser.parse("A|B\n-|-\nmerged||\n^^||", { async: false });
```

Cells use the document's lexer, renderer, extensions and `walkTokens`, including
async callbacks. Container continuation follows Marked's native table behavior.

## markdown-it

```sh
bun add markdown-it
```

```ts
import MarkdownIt from "markdown-it";
import markdownItMultimdTable from "multimd-table/markdown-it";

const parser = new MarkdownIt().use(markdownItMultimdTable, {
  rowspan: true,
  multiline: true,
});
const html = parser.render("A|B\n-|-\nmerged||\n^^||");
```

Renderer rules and table enable/disable settings are preserved. With the
CommonMark preset, call `.enable("table")` to enable tables.

## MDX

```sh
bun add @mdx-js/mdx remark-gfm unified mdast-util-from-markdown
```

```ts
import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

const result = await compile("A|B\n-|-\n{1 + 1}|note\n^^|next", {
  remarkPlugins: [remarkGfm, [remarkMultimdTable, { rowspan: true }]],
});
```

JSX and expressions inside cells follow MDX's syntax and runtime. MDX bundler
integrations use the same `remarkPlugins` configuration.

## Standalone core

```ts
import { parseTable, expandSection } from "multimd-table";

const table = parseTable("A|B\n-|-\nmerged||\n^^||", { rowspan: true });
if (table) {
  const body = table.sections.find((section) => section.kind === "body");
  const grid = body ? expandSection(body) : [];
  // grid[1][0].value === "merged"
  // grid[1][0].origin === grid[0][0].origin
  // grid[1][0].inherited === true
}
```

First body cell (selected fields):

```json
{
  "value": "merged",
  "column": 0,
  "colspan": 2,
  "rowspan": 2,
  "range": { "start": 8, "end": 14 }
}
```

`parseTable` recognizes one table **at the start of the string**, stopping at the
first rejected line. Cell values remain Markdown strings. Use an adapter for
whole documents: the core does not handle outer fences, lists or block quotes.

## Standalone writer

```ts
import { stringifyTable } from "multimd-table/writer";

const source = stringifyTable({
  columns: [{ align: null }, { align: "right" }],
  sections: [
    {
      kind: "body",
      rows: [
        { cells: [{ column: 0, colspan: 2, rowspan: 2, value: "Merged" }] },
        { cells: [] }, // Covered by the cell above.
      ],
    },
  ],
});
```

Generated Markdown:

```text
|---|---:|
| Merged ||
| ^^ ||
```

The writer accepts Markdown strings and a grid without source ranges. It emits
canonical table syntax, validates complete span coverage, and preserves
Markdown semantics rather than source whitespace. Read the output with
`{ rowspan: true, multiline: true, headerless: true, multibody: true }`.
Unrepresentable content throws `RangeError`; see the
[writer contract](#writer-multimd-tablewriter) before integrating an editor.

## Syntax

- **Column span:** adjacent pipes, e.g. `Total||27`. Always enabled; retain trailing
  pipes when the span reaches the row's end.
- **Row span:** `^^` with `rowspan: true`; spans stay within a header/body section.
- **Empty cell:** whitespace between pipes, e.g. `A| |C`. `A||C` is a span.
- Outer pipes are optional. Escape literal pipes as `\|`; pipes inside code spans
  with matching backtick delimiters do not split cells. Unclosed backticks are literal.
- Delimiters accept `---` or `===`. Use `:---`, `---:` or `:---:` for alignment;
  append `+` to give the column an `extend` class for your stylesheet.
- All rows before the delimiter are headers. With `headerless: true`, start with
  the delimiter followed by a body row.
- Put `[Caption]` immediately before or after the table. The first caption wins;
  a second stays outside. Inline Markdown is supported. `[Caption][label]` gives
  an explicit ID; otherwise `autolabel` generates one. IDs are lowercased with
  non-word characters removed.

With `multiline: true`, a backslash at the physical end of a line continues the
row. End the final line without a backslash:

```text
| Task   | Notes   |
| ------ | ------- |
| Launch | - Build |\
|        | - Test  |
```

This is one body row with **Launch** and a two-item list. Joined cells support
block Markdown, including paragraphs, lists and code. Keep columns aligned and
do not put whitespace after the continuation backslash.

With `multibody: true`, one blank line between body rows starts another `tbody`;
two end the table. A blank line immediately after the delimiter ends the table
before its first body row. With `multibody: false`, any blank line ends the table.

## Options

The core and all adapters accept the same options:

| Option       | Default | Effect                                                     |
| ------------ | ------- | ---------------------------------------------------------- |
| `rowspan`    | `false` | Recognize `^^` as an upward continuation.                  |
| `multiline`  | `false` | Join backslash-ended rows and parse their cells as blocks. |
| `headerless` | `false` | Allow a table to start with its delimiter.                 |
| `multibody`  | `true`  | Allow one blank line between body sections.                |
| `autolabel`  | `true`  | Generate an ID for an unlabeled caption.                   |

## Rendering and compatibility

Custom components and sanitizers must retain the features you use: `rowSpan`,
`colSpan`, cell `text-align`, the `extend` class, and `caption` with its `id` and
bottom `caption-side`. Cell HTML and URLs follow the host's policies.

Cell Markdown, source normalization and container boundaries follow the host.

Marked 18.1.1's native Setext-heading detection is slow on Bun 1.4.3 for long lists
with many continuation lines, even without tables. Use Node or another adapter
for that workload.
