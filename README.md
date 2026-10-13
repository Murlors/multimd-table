# multimd-table

MultiMarkdown-style tables with merged cells, captions, multiple headers, and
multiline Markdown content. Use a native adapter for **remark**, **Marked**, or
**markdown-it**, or the **parser-independent core** for structured table models.

```markdown
| Region | Quarter | Revenue |
| ------ | ------- | ------- |
| North  | Q1      | 12      |
| ^^     | Q2      | 15      |
| Total           || 27      |
```

With `{ rowspan: true }`, this becomes:

<table>
  <thead>
    <tr><th>Region</th><th>Quarter</th><th>Revenue</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2">North</td><td>Q1</td><td>12</td></tr>
    <tr><td>Q2</td><td>15</td></tr>
    <tr><td colspan="2">Total</td><td>27</td></tr>
  </tbody>
</table>

`^^` extends **North** across two rows. The adjacent `||` extends **Total**
across two columns.

The package is currently in beta; the public API may change before 1.0.

## Quick start: react-markdown

Install the package, React, the renderer, and the remark adapter's peers:

```sh
bun add multimd-table@beta react react-dom react-markdown remark-gfm unified mdast-util-from-markdown
```

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

const markdown = `
| Region | Quarter | Revenue |
| ------ | ------- | ------- |
| North  | Q1      | 12      |
| ^^     | Q2      | 15      |
| Total           || 27      |
`;

export default function Report() {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, [remarkMultimdTable, { rowspan: true }]]}
    >
      {markdown}
    </ReactMarkdown>
  );
}
```

Place `remarkMultimdTable` **after `remarkGfm`** when using both plugins.
`remarkGfm` is optional; it supplies features such as strikethrough and
footnotes. `rehype-raw` is not required to render these tables.

For custom components and sanitizers, see [rendering](#rendering).

## Quick start: remark / unified

For a Markdown-to-HTML pipeline:

```sh
bun add multimd-table@beta unified remark-parse remark-gfm remark-rehype rehype-stringify mdast-util-from-markdown
```

```ts
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkMultimdTable from "multimd-table/remark";

const markdown = "A|B\n-|-\nmerged||\n^^||";
const html = String(
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMultimdTable, { rowspan: true })
    .use(remarkRehype)
    .use(rehypeStringify)
    .processSync(markdown),
);

console.log(html); // A table with one body cell spanning two rows and columns.
```

`remark-rehype` converts the adapter's nodes to native HTML table elements.

## Quick start: Marked

```sh
bun add multimd-table@beta marked
```

```ts
import { Marked } from "marked";
import markedMultimdTable from "multimd-table/marked";

const parser = new Marked(
  markedMultimdTable({ rowspan: true, multiline: true }),
);
console.log(parser.parse("A|B\n-|-\nmerged||\n^^||", { async: false }));
```

Cells use the same lexer and renderer as the document. Custom extensions and
`walkTokens`, including async callbacks, also apply inside cells. Container
continuation follows Marked's native table behavior.

## Quick start: markdown-it

```sh
bun add multimd-table@beta markdown-it
```

```ts
import MarkdownIt from "markdown-it";
import markdownItMultimdTable from "multimd-table/markdown-it";

const parser = new MarkdownIt().use(markdownItMultimdTable, {
  rowspan: true,
  multiline: true,
});
console.log(parser.render("A|B\n-|-\nmerged||\n^^||"));
```

The plugin preserves the host's table enable/disable setting and renderer
rules. With the CommonMark preset, call `.enable("table")` to enable tables.

## Quick start: MDX

MDX uses the same remark plugin through `remarkPlugins`:

```sh
bun add multimd-table@beta @mdx-js/mdx remark-gfm unified mdast-util-from-markdown
```

```ts
import { compile } from "@mdx-js/mdx";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

const result = await compile("A|B\n-|-\n{1 + 1}|note\n^^|next", {
  remarkPlugins: [
    remarkGfm,
    [remarkMultimdTable, { rowspan: true, multiline: true }],
  ],
});
console.log(String(result)); // Compiled MDX JavaScript.
```

JSX components and expressions inside cells follow MDX's syntax and runtime.
The same `remarkPlugins` configuration works in an MDX bundler integration.

## Standalone core

Use the root entry when you own document boundaries, cell interpretation, and
rendering. It has no runtime imports or requirement for the remark peers.

```sh
bun add multimd-table@beta
```

```ts
import { parseTable, expandSection } from "multimd-table";

const source = [
  "Region|Quarter|Revenue",
  "------|-------|-------",
  "North|Q1|12",
  "^^|Q2|15",
  "Total||27",
].join("\n");

const table = parseTable(source, { rowspan: true });
if (!table) throw new Error("Not a table");

const body = table.sections.find((section) => section.kind === "body");
if (!body) throw new Error("No body section");

const grid = expandSection(body);
console.log(grid.map((row) => row.map((cell) => cell?.value ?? null)));
// [
//   ["North", "Q1", "12"],
//   ["North", "Q2", "15"],
//   ["Total", "Total", "27"],
// ]

console.log(grid[1]?.[0]?.inherited); // true
console.log(grid[1]?.[0]?.origin === grid[0]?.[0]?.origin); // true
```

`parseTable` recognizes **one table at the start of the string** and stops at
the first rejected line. The host must handle outer code fences, lists, and
block quotes; use the remark adapter for whole documents.

Cell values remain Markdown strings. `expandSection` fills positions covered
by spans, retaining the original cell as `origin` and marking copies as
`inherited`. Missing positions are `null`; sections are expanded separately.

## Table syntax

### Merged and empty cells

- **Column span:** add adjacent pipes after a cell, such as `Total||27`.
  Column spans are always enabled; keep trailing pipes when the span reaches
  the end of a row.
- **Row span:** with `rowspan: true`, put `^^` in the column to continue the
  cell above. Row spans stay within their header or body section.
- **Empty cell:** put whitespace between the pipes: `A| |C`. A truly empty
  segment (`A||C`) extends the preceding cell instead.
- Leading and trailing outer pipes are optional. Escape a literal pipe as
  `\|`; pipes inside code spans follow the reference parser's backtick rules.

### Alignment, captions, and headers

```markdown
[Quarterly results][quarterly_results]
| Region | Revenue | Notes       |
| :----- | ------: | :---------:+ |
| North  | 27      | **On track** |
```

- Delimiters may use hyphens (`---`) or equals (`===`). Colons select left
  (`:---`), right (`---:`), or center (`:---:`) alignment.
- A trailing `+` marks a column with the `extend` class. The package supplies
  the marker; your stylesheet decides how the column wraps.
- A caption goes immediately before or after the table. The first caption
  wins; a second remains outside the table. Captions support inline Markdown.
- `[Caption][label]` sets an explicit caption ID. Otherwise `autolabel: true`
  generates one from the caption. IDs are lowercased and non-word characters
  removed: `[Quarterly results]` becomes `quarterlyresults`.
- Every row before the delimiter is a header row. For a table without headers,
  enable `headerless` and begin with the delimiter followed by a body row.

### Multiline cells and body sections

With `multiline: true`, a backslash at the physical end of a line continues
the row. End the final line without a backslash:

```markdown
| Task   | Notes   |
| ------ | ------- |
| Launch | - Build |\
|        | - Test  |
```

This creates one body row: **Launch** in the first cell and a two-item list in
the second. Joined cells are parsed as block Markdown, supporting paragraphs,
lists, and fenced or indented code. Keep the columns aligned across lines and
do not add whitespace after the continuation backslash.

With `multibody: true` (the default), one blank line **between body rows**
starts a new body section (`tbody`). Two blank lines end the table. A blank
line immediately after the delimiter ends the table before its first body
row. With `multibody: false`, any blank line ends the table.

## Options

Pass the same options to `parseTable`, `TableScanner`, or any adapter.

| Option | Default | Effect |
| --- | --- | --- |
| `rowspan` | `false` | Recognize `^^` as a continuation of the cell above. |
| `multiline` | `false` | Join physical rows ending in a backslash and parse their cells as blocks. |
| `headerless` | `false` | Allow the delimiter to open a table without header rows. |
| `multibody` | `true` | Allow one blank line between body sections. |
| `autolabel` | `true` | Generate a caption ID when no explicit label is supplied. |

## Public API

The package is **ESM only**, with TypeScript declarations for every entry.
Use named imports from the core and default imports for the adapters. Host
dependencies are optional: install only the parser used by your adapter.

### `multimd-table`

| Export | Contract |
| --- | --- |
| `parseTable(source, options?)` | Return the leading `Table`, or `null` when no table is recognized. |
| `expandSection(section)` | Return a rectangular `(ExpandedCell \| null)[][]` grid, preserving `origin` and `inherited`. |
| `TableScanner` | Incremental recognition for hosts that provide their own line and document boundaries. |
| `cellBounds(line)` | Return UTF-16 pipe boundaries under the scanner's escape and backtick rules. Missing outer pipes use virtual boundaries: `-1` and the trimmed line end. No valid pipes yields `[]`. |
| `defaults` | Read-only default option values. |

For incremental parsing, construct `new TableScanner(options?)`, then call
`push(line, offset)` with a line without its line ending and its UTF-16 source
offset. Rejection returns `false` without changing state. `finish()` returns
an independent snapshot or `null` and permits further input. The flags are
`committed` (delimiter read), `accepted` (model available), and `finished`
(a bottom caption ended the table).

Exported types: `Options`, `Table`, `Section`, `Row`, `Cell`, `Caption`, `Range`,
`Alignment`, and `ExpandedCell`. All ranges are UTF-16 half-open intervals
(`start` inclusive, `end` exclusive), matching JavaScript string offsets.
A multiline cell's `segments` locate its separate pieces of source text.

### `multimd-table/remark`

The default export is the remark plugin. This entry also exports the types
`RemarkOptions` (the same five core options) and `MultimdNode`. Its runtime
peers are `unified` 11 and `mdast-util-from-markdown` 2; they are optional for
core-only consumers.

`MultimdNode` covers table, section, row, cell, and caption nodes. A
`multimdTable` node retains the core `model`; children contain parsed Markdown,
and `data.hName` / `data.hProperties` describe the HTML structure. Nodes retain
source positions. Markdown serializers need explicit support for these custom
nodes to preserve merged cells.

### `multimd-table/marked`

The default export is `markedMultimdTable(options?)`, returning a
`MarkedExtension` for Marked 18. The exported type `MarkedMultimdTableToken`
describes the table token's core `model`, `cellTokens`, and `captionTokens`.
Model ranges are relative to the token's `raw` text after host normalization.
Marked 18 requires Node.js 20 or later when used in Node.js.

### `multimd-table/markdown-it`

The default export is `markdownItMultimdTable(md, options?)`, a plugin for
markdown-it 15. It emits native table and content tokens, so existing renderer
overrides and inline plugins continue to apply.

## Rendering

When customizing components or configuring a sanitizer, preserve the features
you use:

- `rowSpan` and `colSpan` on `th` / `td`;
- controlled `text-align` values (`left`, `center`, `right`);
- the `extend` class for marked columns;
- `caption`, its `id`, and `caption-side: bottom` for bottom captions.

A sanitizer may strip these elements or properties unless its schema permits
them. Cell content follows the host's HTML and URL policies.

## Compatibility

Table syntax follows
[markdown-it-multimd-table](https://github.com/redbug312/markdown-it-multimd-table)
4.2.3. The host determines inline and block Markdown behavior inside cells.
Source normalization and container boundaries follow the selected host.
Adapters are provided for remark/unified 11, Marked 18, and markdown-it 15.
MDX 3 and react-markdown use the remark adapter.

Marked 18.1.1 can be slow on Bun 1.4.3 for long lists with many continuation
lines, due to its native Setext-heading detection. This also affects documents
without tables; use Node or the remark/markdown-it adapter for that workload.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for license and upstream
attribution details.
