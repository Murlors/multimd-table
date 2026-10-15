import { expect, test } from "bun:test";
import { cellBounds, parseTable, expandSection, TableScanner } from "../src/core.js";

test("pipe scanning distinguishes escape parity, matched tick runs and literal ticks", () => {
  const values: [string, string[]][] = [
    ["name|value", ["name", "value"]],
    ["|name||value|", ["name", "", "value"]],
    [" |value|", [" ", "value"]],
    ["name\\|part|value", ["name\\|part", "value"]],
    ["name\\\\|value", ["name\\\\", "value"]],
    ["`name|part`|value", ["`name|part`", "value"]],
    ["``name`|part``|value", ["``name`|part``", "value"]],
    ["`unclosed|value", ["`unclosed", "value"]],
    ["\\`name|value`", ["\\`name", "value`"]],
    ["\\``part|text`|tail", ["\\``part|text`", "tail"]],
    ["\\```part|text``|tail", ["\\```part|text``", "tail"]],
  ];
  for (const [source, expected] of values) {
    const bounds = cellBounds(source);
    expect(bounds.slice(1).map((end, index) => source.slice(bounds[index]! + 1, end)))
      .toEqual(expected);
  }
  expect(cellBounds("`one|two`")).toEqual([]);
  expect(cellBounds("literal\\|pipe")).toEqual([]);
});

test("all model ranges remain independent and point into multiline Unicode source", () => {
  const source = "[**清单**][List-7]\r\n|Category|Count|\r\n|:---|---:+|\r\n|青瓷😀|one|\\\r\n|碗|two|\r\n|^^|next|";
  const table = parseTable(source, { multiline: true, rowspan: true })!;
  expect(table.caption).toMatchObject({ id: "list7", value: "**清单**", side: "top" });
  expect(source.slice(table.caption!.contentRange.start, table.caption!.contentRange.end))
    .toBe("**清单**");
  expect(table.columns).toEqual([{ align: "left", wrap: false }, { align: "right", wrap: true }]);
  const body = table.sections[1]!;
  expect(body.rows).toHaveLength(2);
  expect(body.rows[0]!.cells[0]).toMatchObject({ value: "青瓷😀\n碗", rowspan: 2, block: true });
  expect(expandSection(body)[1]![0]!.origin).toBe(body.rows[0]!.cells[0]!);
  for (const section of table.sections)
    for (const row of section.rows)
      for (const cell of row.cells)
        expect(cell.segments.map(({ start, end }) => source.slice(start, end)).join("\n"))
          .toBe(cell.value);
});

test("captions balance nested links and reject partial or empty bracket lines", () => {
  const table = parseTable("[[catalog](/shop) and \\[note\\]]\nItem|Count\n-|-\nCup|2")!;
  expect(table.caption!.value).toBe("[catalog](/shop) and \\[note\\]");
  for (const value of ["Use `[` here", "Use `]` here", "Use ``[`]`` here", "Use \\``[` here"])
    expect(parseTable(`[${value}]\nItem|Count\n-|-\nCup|2`)!.caption!.value).toBe(value);
  for (const prefix of ["[]", "[unfinished", "[label] extra"])
    expect(parseTable(`${prefix}\nItem|Count\n-|-\nCup|2`)).toBeNull();
});

test("unfinished continuations fall back at a header delimiter and at EOF without markers", () => {
  const source = "Item|Qty|\\\n---|---|\nCup|2|\\\nPlate|4|\\";
  const table = parseTable(source, { multiline: true })!;
  expect(table.sections.map(section => section.rows.map(row => row.cells.map(cell => cell.value))))
    .toEqual([[["Item", "Qty"]], [["Cup", "2"], ["Plate", "4"]]]);
  for (const section of table.sections)
    for (const row of section.rows)
      for (const cell of row.cells) {
        expect(cell.block).toBe(false);
        expect(cell.segments.map(({ start, end }) => source.slice(start, end)).join("\n"))
          .toBe(cell.value);
      }
});

test("a bare outer pipe does not count as table content or mutate scanner state", () => {
  expect(parseTable("|---|---|\n|", { headerless: true })).toBeNull();
  const scanner = new TableScanner({ headerless: true });
  expect(scanner.push("|---|---|", 0)).toBe(true);
  expect(scanner.push("|", 10)).toBe(false);
  expect(scanner.accepted).toBe(false);
  expect(scanner.finish()).toBeNull();
  expect(scanner.push("Cup|2", 12)).toBe(true);
  const snapshot = scanner.finish();
  expect(scanner.push("|", 18)).toBe(false);
  expect(scanner.finish()).toEqual(snapshot);
});

test("section gaps and trailing blank input do not expand the consumed table range", () => {
  const source = "Item|Count\n-|-\nCup|2";
  expect(parseTable(source + "\n\n\nOutside")!.range.end).toBe(source.length);
  expect(parseTable("Item|Count\n-|-\n\nCup|2")!.sections.map(({ kind }) => kind))
    .toEqual(["head"]);
  const scanner = new TableScanner({ headerless: true });
  expect(scanner.push("-|-", 0)).toBe(true);
  expect(scanner.finish()).toBeNull();
  expect(scanner.push("", 4)).toBe(false);
  expect(scanner.push("Cup|2", 5)).toBe(true);
  expect(scanner.finish()!.sections[0]!.kind).toBe("body");
});

test("continued markers extend one source cell once per logical row", () => {
  const table = parseTable("Left|Right\n-|-\nshared||\n^^|^^\n^^||", { rowspan: true })!;
  const body = table.sections[1]!;
  expect(body.rows[0]!.cells[0]).toMatchObject({ colspan: 2, rowspan: 3 });
  expect(body.rows[1]!.cells).toEqual([]);
  expect(body.rows[2]!.cells).toEqual([]);
  expect(expandSection(body).flat().every((cell) => cell?.value === "shared")).toBe(true);
});
