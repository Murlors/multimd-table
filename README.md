# multimd-table

Parser-independent MultiMarkdown tables with a native remark adapter.

The first beta is `0.1.0-beta.1`. The public API may change before 1.0.

Table recognition, spans and source ranges are independent of the Markdown
host. The root entry has no runtime imports. `multimd-table/remark` is a
separate entry; its runtime peers are optional for core-only consumers. The
package includes type dependencies, but does not pull a Markdown runtime into
the core bundle. The implementation is TypeScript.

For the standalone core:

```sh
bun add multimd-table@beta
```

## Core API

```ts
import { parseTable, expandSection } from "multimd-table";

const table = parseTable("A|B\n-|-\nx|1\n^^|2", { rowspan: true });
if (table) {
  const body = table.sections.find((section) => section.kind === "body");
  const rows = body ? expandSection(body) : [];
}
```

`parseTable` recognizes one table at the start of a string. Hosts own outer
document boundaries such as code fences, lists and quotes. `TableScanner`
provides incremental recognition for adapters. `expandSection` preserves
origin identity: repeated inherited values are not independent numeric facts.

| API                                       | Contract                                                                                                                           |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `parseTable(source, options?)`            | Returns the leading `Table`, or `null`; stops at the first rejected line.                                                          |
| `new TableScanner(options?)`              | Incremental parser for hosts that own line boundaries.                                                                             |
| `scanner.push(line, offset)`              | Pass one physical line without its line ending and its UTF-16 start offset. A rejected line leaves scanner state unchanged.        |
| `scanner.finish()`                        | Returns an independent snapshot or `null`; can be repeated and does not close the scanner.                                         |
| `scanner.committed / accepted / finished` | Delimiter recognized / a table can be produced / terminating caption consumed. A rejected input does not itself close the scanner. |
| `expandSection(section)`                  | Returns a rectangular grid with `null` holes, original cell identity and an `inherited` flag; never merges separate sections.      |
| `defaults`                                | Read-only default option values.                                                                                                   |

Core types (`Options`, `Table`, `Section`, `Row`, `Cell`, `Caption`, `Range`,
`Alignment`, `ExpandedCell`) are exported from the root. All ranges are UTF-16
half-open intervals. `cellBounds` exposes the same pipe-boundary rule used by
the scanner for low-level host integrations; it is not a document parser.

## remark / ReactMarkdown

Use the remark plugin for Markdown-host integration. The standalone core API
is intended for consumers that own their document boundaries and rendering.

For the example below, install ReactMarkdown, remark-gfm and the adapter peers
alongside the package:

```sh
bun add multimd-table@beta react react-dom react-markdown remark-gfm unified mdast-util-from-markdown
```

```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "multimd-table/remark";

<ReactMarkdown
  remarkPlugins={[remarkGfm, [remarkMultimdTable, { rowspan: true, multiline: true }]]}
>
  {markdown}
</ReactMarkdown>;
```

Place this plugin **after remark-gfm**. Native mdast nodes carry safe table
structure to HAST; `rehype-raw` is not required. Keep `rowSpan` and `colSpan`
props when overriding the renderer's `th` or `td` components. Other inline
extensions remain owned by the host. Default HTML/URL policies also remain
owned by the host.

Custom renderers should also preserve controlled alignment (`text-align`),
the `extend` class for wrappable columns, and caption placement
(`caption-side: bottom`). A host sanitizer may remove these attributes or
the `caption` element; configure only the fixed values you support, rather
than permitting arbitrary CSS. No raw-HTML permission is required for this
plugin's own tables.

The adapter emits custom table nodes and preserves UTF-16 source positions.
Markdown serialization and rich-text editing are not implemented; do not send
these nodes to a serializer that only understands standard GFM tables.
The adapter exports `RemarkOptions` (the same five core options) and
`MultimdNode`. A `multimdTable` node retains its core `model` for inspection;
its `children` contain host-parsed Markdown and `data.hName/hProperties`
describe native table elements. The model is useful for consumers deciding
whether their editor can safely round-trip a table. Internal token state and
scanner-backend factories are not public extension points.

## Parsing flow

The core scanner owns table structure only. The remark adapter registers a
native micromark flow construct, passes accepted lines to `TableScanner`, then
creates mdast table nodes. Ordinary cells are parsed in one batch with the
host's inline extensions; multiline block cells are parsed separately to
preserve block boundaries. Source positions are mapped back to the original
document. remark-rehype and ReactMarkdown keep owning the final rendering.

Link and footnote identifiers are shared with cell parsers. A new definition
inside a multiline cell may be discovered after the outer inline pass; only
such documents require a second native parse so earlier cells and surrounding
text can resolve it. No text nodes are rewritten into links. Source and
reference state are scoped to one synchronous parse and restored on failure.
Duplicate definitions follow host AST traversal order. Multiline blocks are
parsed one cell at a time, matching the reference plugin; this can differ
from the physical line order across two cells of the same multiline row.

## Compatibility target

The reference is `markdown-it-multimd-table` 4.2.3 at commit
`a5b1277bab21677ccd5a77b4766a5d7f3b4cd3fa`, not the full MultiMarkdown language.
The TS suite covers all 54 upstream fixtures, plus option combinations and
integration tests. Supported features:

| Capability           | Reference behavior                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| Column spans         | Adjacent pipes extend the preceding cell; whitespace-only cells remain cells                             |
| Row spans            | `^^` continues a cell above when `rowspan` is enabled                                                    |
| Multiple header rows | All rows before the delimiter belong to the header                                                       |
| Column delimiters    | Hyphens or equals; colon alignment; trailing `+` sets the `extend` class                                 |
| Captions             | Before or after the table; the first caption wins; inline Markdown supported                             |
| Labels               | Explicit `[caption][label]`, otherwise generated when `autolabel` is enabled                             |
| Multiple bodies      | One blank line separates bodies when `multibody` is enabled                                              |
| Headerless tables    | A delimiter can open the table when `headerless` is enabled                                              |
| Multiline cells      | Trailing backslash joins physical rows when `multiline` is enabled                                       |
| Block contents       | Multiline cells may contain paragraphs, nested lists and fenced/indented code                            |
| Syntax boundaries    | Optional outer pipes, escaped pipes, backtick rules, ragged rows and empty cells                         |
| Host context         | Lists, block quotes, references, fenced examples and surrounding paragraphs are covered by adapter tests |

Reference defaults: `multiline: false`, `rowspan: false`, `headerless: false`,
`multibody: true`, `autolabel: true`. Inline and block Markdown are interpreted
by the host, so host-specific Markdown differences are not parser-core bugs.

## Local development

```sh
bun install
bun run test
bun run check
bun run check:package
```

`bun run test` runs the TS suite. `bun run check` runs TypeScript checking,
the suite under micromark's development assertions, and the package build.
`bun run check:package` builds a real tarball and installs it in separate core
and remark consumers, checking Bun, Node and TypeScript with no link to the
development checkout. The core consumer deliberately omits the adapter peers.
Node must be available for this check. `prepack` runs the standard check before
creating a release artifact. Source files accompany source/declaration maps
so consumer debugging and type navigation do not point at missing files.

No editor UI, indexing service or browser layout engine is included. The
package tests include React server rendering. No rich-text serializer is
included.

## Licensing

MIT. The table boundary scanning, recognition rules and compatibility fixtures
are adapted from [markdown-it-multimd-table](https://github.com/redbug312/markdown-it-multimd-table)
4.2.3, copyright (c) 2019 RedBug312. The upstream copyright and MIT license are
preserved in [LICENSE](LICENSE); see [NOTICE](NOTICE) for attribution details.
