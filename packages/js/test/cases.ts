import type { Options } from "../src/core.js";

/** 手写语法用例及 HTML 契约；预期结果不依赖其他表格插件。 */
export const syntaxCases: { name: string; source: string; html: string; options?: Options }[] = [
  {
    name: "unfinished header and body continuations retain inline rows",
    source: "Item|Qty|\\\n---|---|\nCup|2|\\\nPlate|4|\\",
    options: { multiline: true },
    html: "<table><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Cup</td><td>2</td></tr><tr><td>Plate</td><td>4</td></tr></tbody></table>",
  },
  {
    name: "a bare outer pipe is not headerless table data",
    source: "|---|---|\n|",
    options: { headerless: true },
    html: "<p>|---|---|\n|</p>",
  },
  {
    name: "code spans shield brackets inside captions",
    source: "[Use `[` here]\nItem|Qty\n-|-\nCup|2",
    html: '<table><caption id="usehere">Use <code>[</code> here</caption><thead><tr><th>Item</th><th>Qty</th></tr></thead><tbody><tr><td>Cup</td><td>2</td></tr></tbody></table>',
  },
  {
    name: "escaped backticks can precede a code span containing pipes",
    source: "Text|Qty\n-|-\n\\``part|text`|2",
    html: "<table><thead><tr><th>Text</th><th>Qty</th></tr></thead><tbody><tr><td>`<code>part|text</code></td><td>2</td></tr></tbody></table>",
  },
  {
    name: "ordinary rows with optional outer pipes",
    source: "Product|Units\n---|---\n|Teapot|7|\nMug|9",
    html: "<table><thead><tr><th>Product</th><th>Units</th></tr></thead><tbody><tr><td>Teapot</td><td>7</td></tr><tr><td>Mug</td><td>9</td></tr></tbody></table>",
  },
  {
    name: "multiple header rows and horizontal spans",
    source: "Stock||\nItem|Count\n---|---\nMug|9",
    html: '<table><thead><tr><th colspan="2">Stock</th></tr><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Mug</td><td>9</td></tr></tbody></table>',
  },
  {
    name: "vertical spans and horizontal totals",
    source: "Group|Value\n-|-\nWest|4\n^^|6\nSum||",
    options: { rowspan: true },
    html: '<table><thead><tr><th>Group</th><th>Value</th></tr></thead><tbody><tr><td rowspan="2">West</td><td>4</td></tr><tr><td>6</td></tr><tr><td colspan="2">Sum</td></tr></tbody></table>',
  },
  {
    name: "row markers are text by default",
    source: "Label|Flag\n-|-\nEntry|^^",
    html: "<table><thead><tr><th>Label</th><th>Flag</th></tr></thead><tbody><tr><td>Entry</td><td>^^</td></tr></tbody></table>",
  },
  {
    name: "whitespace empty cells remain separate from spans",
    source: "A|B|C\n-|-|-\nleft| |right\nwide||end",
    html: '<table><thead><tr><th>A</th><th>B</th><th>C</th></tr></thead><tbody><tr><td>left</td><td></td><td>right</td></tr><tr><td colspan="2">wide</td><td>end</td></tr></tbody></table>',
  },
  {
    name: "alignment and extend apply to headers and data",
    source: "L|C|R\n:===|:===:+|===:\none|two|three",
    html: '<table><thead><tr><th style="text-align:left">L</th><th style="text-align:center" class="extend">C</th><th style="text-align:right">R</th></tr></thead><tbody><tr><td style="text-align:left">one</td><td style="text-align:center" class="extend">two</td><td style="text-align:right">three</td></tr></tbody></table>',
  },
  {
    name: "top captions retain inline markup and explicit labels",
    source: "[**Inventory**][Shelf-A]\nItem|Count\n-|-\nCup|3",
    html: '<table><caption id="shelfa"><strong>Inventory</strong></caption><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Cup</td><td>3</td></tr></tbody></table>',
  },
  {
    name: "bottom captions without generated identifiers",
    source: "Item|Count\n-|-\nCup|3\n[Inventory]",
    options: { autolabel: false },
    html: '<table><caption style="caption-side: bottom">Inventory</caption><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Cup</td><td>3</td></tr></tbody></table>',
  },
  {
    name: "blank rows create distinct bodies",
    source: "Day|Count\n-|-\nMon|2\n\nTue|3",
    html: "<table><thead><tr><th>Day</th><th>Count</th></tr></thead><tbody><tr><td>Mon</td><td>2</td></tr></tbody><tbody><tr><td>Tue</td><td>3</td></tr></tbody></table>",
  },
  {
    name: "row spans stay within body boundaries",
    source: "Day|Count\n-|-\nMon|2\n\n^^|3",
    options: { rowspan: true },
    html: "<table><thead><tr><th>Day</th><th>Count</th></tr></thead><tbody><tr><td>Mon</td><td>2</td></tr></tbody><tbody><tr><td>^^</td><td>3</td></tr></tbody></table>",
  },
  {
    name: "headerless merged cells",
    source: "--|--\nshared||\n^^||",
    options: { headerless: true, rowspan: true },
    html: '<table><tbody><tr><td colspan="2" rowspan="2">shared</td></tr><tr></tr></tbody></table>',
  },
  {
    name: "continued cells contain lists and paragraphs",
    source: "Action|Notes\n-|-\n- pack|first|\\\n- ship|second|",
    options: { multiline: true },
    html: "<table><thead><tr><th>Action</th><th>Notes</th></tr></thead><tbody><tr><td><ul><li>pack</li><li>ship</li></ul></td><td><p>first\nsecond</p></td></tr></tbody></table>",
  },
  {
    name: "literal pipes and code spans",
    source: "Text|Code\n-|-\nleft\\|right|`key|value`",
    html: "<table><thead><tr><th>Text</th><th>Code</th></tr></thead><tbody><tr><td>left|right</td><td><code>key|value</code></td></tr></tbody></table>",
  },
  {
    name: "a second caption remains outside the table",
    source: "[Primary]\nItem|Count\n-|-\nCup|3\n[Secondary]",
    html: '<table><caption id="primary">Primary</caption><thead><tr><th>Item</th><th>Count</th></tr></thead><tbody><tr><td>Cup</td><td>3</td></tr></tbody></table><p>[Secondary]</p>',
  },
];

/** 独立表达五个开关的交互结果，用于三个宿主的同一组契约测试。 */
export function optionCases(options: Required<Options>) {
  const caption = `<caption${options.autolabel ? ' id="stock"' : ""}><strong>Stock</strong></caption>`;
  const head =
    '<thead><tr><th style="text-align:left">Zone</th><th style="text-align:right" class="extend">Count</th></tr></thead>';
  const marker = options.rowspan ? "" : '<td style="text-align:left">^^</td>';
  const first = `<tbody><tr><td style="text-align:left"${options.rowspan ? ' rowspan="2"' : ""}>North</td><td style="text-align:right" class="extend">2</td></tr><tr>${marker}<td style="text-align:right" class="extend">3</td></tr></tbody>`;
  const last = options.multibody
    ? '<tbody><tr><td style="text-align:left">South</td><td style="text-align:right" class="extend">5</td></tr></tbody></table>'
    : "</table><p>South|5</p>";
  return [
    {
      source: "[**Stock**]\nZone|Count\n:---|---:+\nNorth|2\n^^|3\n\nSouth|5",
      html: `<table>${caption}${head}${first}${last}`,
    },
    {
      source: "--|--\nshared||\n^^||",
      html: options.headerless
        ? `<table><tbody><tr><td colspan="2"${options.rowspan ? ' rowspan="2"' : ""}>shared</td></tr><tr>${options.rowspan ? "" : '<td colspan="2">^^</td>'}</tr></tbody></table>`
        : "<p>--|--\nshared||\n^^||</p>",
    },
    {
      source: "Step|Note\n-|-\nfirst|alpha\\\nsecond|beta",
      html:
        "<table><thead><tr><th>Step</th><th>Note</th></tr></thead><tbody>" +
        (options.multiline
          ? "<tr><td><p>first\nsecond</p></td><td><p>alpha\nbeta</p></td></tr>"
          : "<tr><td>first</td><td>alpha\\</td></tr><tr><td>second</td><td>beta</td></tr>") +
        "</tbody></table>",
    },
  ];
}
