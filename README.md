# multimd-table

[![npm version](https://img.shields.io/npm/v/multimd-table?logo=npm)](https://www.npmjs.com/package/multimd-table)
[![Playground: Try online](https://img.shields.io/badge/%E2%96%B6_Playground-Try_online-6366f1)](https://murlors.github.io/multimd-table/)

**Merged cells for your Markdown stack.**

Use MultiMarkdown syntax for row spans, column spans, grouped headers and multiline
cells. Render tables with your existing Markdown stack, extract structured data,
or write table data back to Markdown.

[Integrations](#integrations) · [API reference](docs/api.md)

## Install

```sh
bun add multimd-table
```

ESM only, with TypeScript declarations. The included Rust/WASM core initializes
on import; calls are synchronous afterward. Consumers do not need Rust.
See [runtime requirements](#compatibility) before bundling.

## Quick start

Parse a table without a framework or renderer:

```ts
import { parseTable } from "multimd-table";

const source = `| Region | Q1 | Q2 |
| ------ | -- | -- |
| North  | 12 | 15 |
| ^^     |  8 | 10 |
| Total      || 45 |
`;

const table = parseTable(source, { rowspan: true });
const body = table?.sections.find((section) => section.kind === "body");
if (body) {
  console.log(body.rows[0].cells[0].rowspan); // 2: North spans two rows
  console.log(body.rows[2].cells[0].colspan); // 2: Total spans two columns
}
```

The core returns structured data. To render a complete Markdown document,
choose an [integration](#integrations) below.

## See it in Markdown

`||` extends a cell to the right; `^^` continues the cell above when
`rowspan: true`. Here is a table with grouped headers and merged row labels:

```text
[Quarterly sales]
| Region | Team | Sales ||
| ^^     | ^^   | Q1 | Q2 |
| ------ | ---- | -- | -- |
| North  | A    | 12 | 15 |
| ^^     | B    |  8 | 10 |

| South  | C    |  9 | 11 |
| Total         ||| 65 |
```

With `{ rowspan: true }`:

<table>
  <caption id="quarterlysales">Quarterly sales</caption>
  <thead>
    <tr><th rowspan="2">Region</th><th rowspan="2">Team</th><th colspan="2">Sales</th></tr>
    <tr><th>Q1</th><th>Q2</th></tr>
  </thead>
  <tbody>
    <tr><td rowspan="2">North</td><td>A</td><td>12</td><td>15</td></tr>
    <tr><td>B</td><td>8</td><td>10</td></tr>
  </tbody>
  <tbody>
    <tr><td>South</td><td>C</td><td>9</td><td>11</td></tr>
    <tr><td colspan="3">Total</td><td>65</td></tr>
  </tbody>
</table>

The caption labels the table, and the blank line separates its body groups.
This syntax needs a multimd-table adapter to render in your app; copying it into
a standard Markdown renderer does not enable merged cells.

## Integrations

Choose the entry for your renderer, or use the core and writer directly.
Each guide includes imports, required peers and a working example.

| Use with                                      | Entry                       | Guide                                                 |
| --------------------------------------------- | --------------------------- | ----------------------------------------------------- |
| <a id="react-markdown"></a>react-markdown     | `multimd-table/remark`      | [React example](docs/api.md#react-markdown)           |
| <a id="remark--unified"></a>remark / unified  | `multimd-table/remark`      | [Render to HTML](docs/api.md#remark--unified)         |
| <a id="mdx"></a>MDX                           | `multimd-table/remark`      | [Compile MDX](docs/api.md#mdx)                        |
| <a id="marked"></a>Marked                     | `multimd-table/marked`      | [Marked example](docs/api.md#marked)                  |
| <a id="markdown-it"></a>markdown-it           | `multimd-table/markdown-it` | [markdown-it example](docs/api.md#markdown-it)        |
| <a id="standalone-core"></a>Structured data   | `multimd-table`             | [Parse and expand cells](docs/api.md#standalone-core) |
| <a id="standalone-writer"></a>Markdown output | `multimd-table/writer`      | [Write a table](docs/api.md#standalone-writer)        |

<a id="why-multimd-table"></a>

Use the adapters when your documents need merged cells, captions or block content
inside tables. The standalone core gives data-processing and editor code access
to cell values, UTF-16 source ranges and shared merged-cell origins. The writer
validates span coverage and rejects content it cannot represent.

## Syntax

| Write                    | Result                                     | Option            |
| ------------------------ | ------------------------------------------ | ----------------- |
| `Total\|\|45`            | Merge adjacent columns                     | Always enabled    |
| `^^`                     | Continue the cell above                    | `rowspan: true`   |
| `[Caption]`              | Label the table                            | Always enabled    |
| Backslash at end of line | Continue a row with multiline cell content | `multiline: true` |

<a id="options"></a>

Row spans and multiline content are opt-in. A blank line between body rows starts
another body section by default. See [syntax and options](docs/api.md#syntax)
for escaping, headerless tables and all defaults.

## Compatibility

<a id="limitations"></a>
<a id="rendering-and-compatibility"></a>

- **Rendering:** this is extended Markdown syntax. Use an adapter to render whole
  documents; the standalone parser reads one table at the start of its input.
  Custom renderers and sanitizers must preserve `rowSpan` and `colSpan`.
- **Runtime:** ESM initialization uses top-level `await`. Bundled output must
  support ES2022 modules and retain the WASM resource. Browsers need WebAssembly;
  CSP must allow its compilation. See [bundlers, SSR and Workers](docs/api.md#runtime-and-bundlers)
  for supported loading paths.

## Documentation

<a id="api"></a>

- [API reference](docs/api.md) — models, scanner lifecycle, adapters and writer contract.
- [Syntax reference](docs/api.md#syntax) — merged cells, captions, multiline content and options.
- [Validation and benchmarks](docs/baselines.md) — correctness checks, workloads and measurement methodology.

## Playground

[Try the Playground](https://murlors.github.io/multimd-table/) to edit Markdown,
preview tables, inspect the parsed model and generate canonical Markdown.
It uses the published `multimd-table@0.4.0` package.

Input is processed in your browser. Share links include their Markdown, so only
share content you intend others to read.
[Local setup and deployment](docs/baselines.md#playground).

## Development

Use Vite+, the Bun version in `packageManager`, Rust and the
`wasm32-unknown-unknown` target.

```sh
git clone https://github.com/Murlors/multimd-table.git
cd multimd-table
vp install
vp run verify
```

The full check covers static checks, Rust and JavaScript tests, builds and isolated
package consumers. See [development commands](docs/baselines.md#development)
for focused checks and Playground development.

## Feedback and support

[Report an issue](https://github.com/Murlors/multimd-table/issues) with the Markdown
input, options, adapter, package version and expected output. A public Playground
share link makes examples easier to reproduce.

If multimd-table helps your project, [consider starring it on GitHub](https://github.com/Murlors/multimd-table).

## License

MIT. See [LICENSE](LICENSE).
