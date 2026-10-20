import MarkdownIt from "markdown-it";
import { parseTable, type Table } from "multimd-table-release";
import { stringifyTable } from "multimd-table-release/writer";
import multimd from "multimd-table-release/markdown-it";
import type { Settings } from "./examples.ts";
import { inputLimit } from "./limits.ts";

export interface Result {
  html: string;
  table: Table | null;
  written: string | null;
  writeError: string | null;
}

/** 模型只读取开头的表格，预览仍按宿主规则渲染整个文档。 */
export function evaluate(source: string, options: Settings): Result {
  if (source.length > inputLimit)
    throw new RangeError("This example is too large. Keep the input under 100,000 characters.");
  const renderer = new MarkdownIt({ html: false }).use(multimd, options);
  const table = parseTable(source, options);
  let written = null,
    writeError = null;
  if (table) {
    try {
      written = stringifyTable(table);
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      writeError = error.message;
    }
  }
  return { html: renderer.render(source), table, written, writeError };
}
