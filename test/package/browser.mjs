import { parseTable, TableScanner, cellBounds } from "multimd-table";
import { stringifyTable } from "multimd-table/writer";
import remark from "multimd-table/remark";
import marked from "multimd-table/marked";
import markdownIt from "multimd-table/markdown-it";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { Marked } from "marked";
import MarkdownIt from "markdown-it";

const assert = (condition, message) => { if (!condition) throw new Error(message); };

export function check() {
  const source = "[Sales]\nA|B\n-|-\n😀||\n^^||";
  const table = parseTable(source, { rowspan: true });
  const cell = table.sections[1].rows[0].cells[0];
  assert(cell.value === "😀" && cell.colspan === 2 && cell.rowspan === 2, "Merged model mismatch");
  const restored = parseTable(stringifyTable(table), { rowspan: true });
  assert(restored.sections[1].rows[0].cells[0].rowspan === 2, "Writer roundtrip mismatch");
  assert(parseTable("A|B\n-|-\n\ud800|x").sections[1].rows[0].cells[0].value.charCodeAt(0) === 0xd800, "Surrogate changed");
  assert(cellBounds("a|`b|c`|d").join(",") === "-1,1,7,9", "Signed bounds mismatch");
  const scanner = new TableScanner();
  try {
    scanner.push("A|B", 2 ** 40);
    scanner.push("-|-", 2 ** 40 + 4);
    scanner.push("x|y", 2 ** 40 + 8);
    assert(scanner.finish().range.end === 2 ** 40 + 11, "Host offset changed");
  } finally { scanner.dispose(); }
  const outputs = [
    String(unified().use(remarkParse).use(remark, { rowspan: true }).use(remarkRehype).use(rehypeStringify).processSync(source)),
    new Marked(marked({ rowspan: true })).parse(source, { async: false }),
    new MarkdownIt().use(markdownIt, { rowspan: true }).render(source),
  ];
  for (const html of outputs) assert(html.includes('rowspan="2"') && html.includes('colspan="2"') && html.includes("<caption"), "Host rendering mismatch");
  return { mergedCells: true, writer: true, unicode: true, safeOffsets: true, hosts: outputs.length };
}
