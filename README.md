# multimd-table

MultiMarkdown tables with merged cells, captions, multiple headers and bodies,
and multiline Markdown. Use **remark**, **Marked**, **markdown-it**, or the
**parser-independent core**.

```markdown
| Region | Quarter | Revenue |
| ------ | ------- | ------- |
| North  | Q1      | 12      |
| ^^     | Q2      | 15      |
| Total           || 27      |
```

With `{ rowspan: true }`:

<table>
  <thead><tr><th>Region</th><th>Quarter</th><th>Revenue</th></tr></thead>
  <tbody>
    <tr><td rowspan="2">North</td><td>Q1</td><td>12</td></tr>
    <tr><td>Q2</td><td>15</td></tr>
    <tr><td colspan="2">Total</td><td>27</td></tr>
  </tbody>
</table>

`^^` extends the cell above; adjacent pipes (`||`) extend the cell to the left.

## Install

```sh
bun add multimd-table
```

ESM only, with TypeScript declarations. Install the host and optional peers for
the adapter you use; the core has no runtime imports.

| Entry | Host / peers |
| --- | --- |
| `multimd-table` | None at runtime |
| `multimd-table/writer` | None at runtime |
| `multimd-table/remark` | `unified` 11, `mdast-util-from-markdown` 2 |
| `multimd-table/marked` | `marked` 18 (Node.js 20+ when used in Node) |
| `multimd-table/markdown-it` | `markdown-it` 15 |

## react-markdown

```sh
bun add react react-dom react-markdown remark-gfm unified mdast-util-from-markdown
```

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

const source = "A|B\n-|-\nmerged||\n^^||";

<ReactMarkdown
  remarkPlugins={[remarkGfm, [remarkMultimdTable, { rowspan: true }]]}
>
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

const html = String(unified()
  .use(remarkParse)
  .use(remarkGfm)
  .use(remarkMultimdTable, { rowspan: true })
  .use(remarkRehype)
  .use(rehypeStringify)
  .processSync("A|B\n-|-\nmerged||\n^^||"));
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
  const body = table.sections.find(section => section.kind === "body");
  const grid = body ? expandSection(body) : [];
  // grid[1][0].value === "merged"
  // grid[1][0].origin === grid[0][0].origin
  // grid[1][0].inherited === true
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
  sections: [{ kind: "body", rows: [
    { cells: [{ column: 0, colspan: 2, rowspan: 2, value: "Merged" }] },
    { cells: [] }, // Covered by the cell above.
  ] }],
});
```

The writer accepts Markdown strings and a grid without source ranges. It emits
canonical table syntax, validates complete span coverage, and preserves
Markdown semantics rather than source whitespace. Read the output with
`{ rowspan: true, multiline: true, headerless: true, multibody: true }`.
Unrepresentable content throws `RangeError`; see the
[writer contract](docs/api.md#writer-multimd-tablewriter) before integrating an editor.

## Syntax

- **Column span:** adjacent pipes, e.g. `Total||27`. Always enabled; retain trailing
  pipes when the span reaches the row's end.
- **Row span:** `^^` with `rowspan: true`; spans stay within a header/body section.
- **Empty cell:** whitespace between pipes, e.g. `A| |C`. `A||C` is a span.
- Outer pipes are optional. Escape literal pipes as `\|`; code-span pipes follow
  the reference parser's backtick rules.
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

```markdown
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

| Option | Default | Effect |
| --- | --- | --- |
| `rowspan` | `false` | Recognize `^^` as an upward continuation. |
| `multiline` | `false` | Join backslash-ended rows and parse their cells as blocks. |
| `headerless` | `false` | Allow a table to start with its delimiter. |
| `multibody` | `true` | Allow one blank line between body sections. |
| `autolabel` | `true` | Generate an ID for an unlabeled caption. |

## API

| Core export | Result |
| --- | --- |
| `parseTable(source, options?)` | Leading `Table`, or `null` |
| `expandSection(section)` | Rectangular grid with `origin`, `inherited` and `null` holes |
| `TableScanner` | Incremental parsing with `push(line, offset)` and `finish()` |
| `cellBounds(line)` | UTF-16 pipe boundaries |
| `defaults` | Read-only option defaults |

Adapters use default imports; core functions and types use named imports. See
the [API reference](https://github.com/Murlors/multimd-table/blob/main/docs/api.md)
for scanner state, source ranges, models and host-specific node/token types.

## Rendering and compatibility

Custom components and sanitizers must retain the features you use: `rowSpan`,
`colSpan`, cell `text-align`, the `extend` class, and `caption` with its `id` and
bottom `caption-side`. Cell HTML and URLs follow the host's policies.

Table syntax follows
[markdown-it-multimd-table 4.2.3](https://github.com/redbug312/markdown-it-multimd-table).
Cell Markdown, source normalization and container boundaries follow the host.

Marked 18.1.1's native Setext-heading detection is slow on Bun 1.4.3 for long lists
with many continuation lines, even without tables. Use Node or another adapter
for that workload.

## License

MIT. See [LICENSE](LICENSE) and [NOTICE](NOTICE) for attribution.
