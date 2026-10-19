import { afterEach, expect, test } from "bun:test";
import { runtime } from "../src/internal/backend.js";
import { parseTable, TableScanner } from "../src/core.js";
afterEach(() => runtime.disposeScanners());

test("mixed line endings retain UTF-16 ranges and stop at rejected input", () => {
  const source = "A|B\r\n-|-\r😀|\ud800\nnot a table\r\nx|y";
  const table = parseTable(source)!;
  const cells = table.sections[1]!.rows[0]!.cells;
  expect(cells.map((cell) => cell.value)).toEqual(["😀", "\ud800"]);
  for (const cell of cells) {
    const segment = cell.segments[0]!;
    expect(source.slice(segment.start, segment.end)).toBe(cell.value);
  }
  expect(table.range.end).toBe(source.indexOf("\nnot a table"));
});

test("single-line whitespace and ragged continuation segments preserve source", () => {
  const source = "A|B\n-|-\n\u00a0\u2003x\u202f\ufeff| \t |\n first | second |\\\n last \n";
  // A continuation without a pipe is rejected without consuming it.
  const scanner = new TableScanner({ multiline: true });
  let offset = 0;
  for (const line of source.split("\n")) {
    if (!scanner.push(line, offset)) break;
    offset += line.length + 1;
  }
  const table = scanner.finish()!;
  const cells = table.sections[1]!.rows[0]!.cells;
  expect(cells.map((cell) => cell.value)).toEqual(["x", ""]);
  expect(cells[1]!.segments[0]!.start).toBe(cells[1]!.segments[0]!.end);
  for (const cell of cells) {
    const segment = cell.segments[0]!;
    expect(source.slice(segment.start, segment.end)).toBe(cell.value);
  }
  const snapshot = structuredClone(table);
  expect(scanner.push("plain rejected line", offset)).toBe(false);
  expect(scanner.finish()).toEqual(snapshot);
  expect(scanner.accepted).toBe(true);
  expect(scanner.committed).toBe(true);
  expect(scanner.finished).toBe(false);

  const blockSource = "A|B\n-|-\n first | second |\\\n last |\n";
  const block = parseTable(blockSource, { multiline: true })!.sections[1]!
    .rows[0]!;
  expect(block.cells.map((cell) => cell.value)).toEqual([
    " first\n last",
    " second",
  ]);
  for (const cell of block.cells) {
    expect(cell.block).toBe(true);
    expect(
      cell.segments
        .map(({ start, end }) => blockSource.slice(start, end))
        .join("\n"),
    ).toBe(cell.value);
  }

  const mergedSource = "A|B\n-|-\nfirst|second\n\u2003^^\u00a0|\ufeff😀\u202f";
  const merged = parseTable(mergedSource, { rowspan: true })!.sections[1]!;
  expect(merged.rows[0]!.cells[0]!.rowspan).toBe(2);
  expect(merged.rows[1]!.cells.map((cell) => cell.value)).toEqual(["😀"]);
  const segment = merged.rows[1]!.cells[0]!.segments[0]!;
  expect(mergedSource.slice(segment.start, segment.end)).toBe("😀");
});

test("continuation validation uses original pipe boundaries before removing slash", () => {
  const table = parseTable("A|B\n-|-\n|\\\nx|y", { multiline: true })!;
  expect(table.sections[1]!.rows).toHaveLength(1);
  expect(table.sections[1]!.rows[0]!.cells).toEqual([]);
});
