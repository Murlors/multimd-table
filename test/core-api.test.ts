import { expect, test } from "bun:test";
import { expandSection, parseTable, TableScanner } from "../src/core.js";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkMultimdTable from "../src/remark.js";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

test("finish returns independent snapshots and permits further input", () => {
  const scanner = new TableScanner({ rowspan: true });
  for (const [line, offset] of [
    ["[title]", 0],
    ["A|B", 8],
    [":-| -", 12],
    ["x|y", 18],
  ] as const)
    expect(scanner.push(line, offset)).toBe(true);
  const first = scanner.finish()!;
  const expected = structuredClone(first);
  first.columns[0]!.align = "right";
  first.columns.push({ align: "center", wrap: true });
  first.caption!.value = "changed";
  first.caption!.range.start = 1000;
  first.caption!.contentRange.end = 1000;
  first.sections[1]!.rows[0]!.cells[0]!.rowspan = 100;
  expect(scanner.finish()).toEqual(expected);
  expect(scanner.finished).toBe(false);
  expect(scanner.push("^^|z", 22)).toBe(true);
  const next = scanner.finish()!;
  expect(next.sections[1]!.rows[0]!.cells[0]!.rowspan).toBe(2);
  expect(next.columns).toEqual(expected.columns);
  expect(expected.sections[1]!.rows[0]!.cells[0]!.rowspan).toBe(1);
});

test("rejection preserves each scanner phase and its source ranges", () => {
  const scanner = new TableScanner({ headerless: true });
  const reject = () => {
    const model = scanner.finish();
    const flags = [scanner.accepted, scanner.committed, scanner.finished];
    expect(scanner.push("rejected", 999)).toBe(false);
    expect(scanner.finish()).toEqual(model);
    expect([scanner.accepted, scanner.committed, scanner.finished]).toEqual(
      flags,
    );
  };
  reject();
  expect(scanner.push("-|-", 10)).toBe(true);
  expect(scanner.committed).toBe(true);
  expect(scanner.accepted).toBe(false);
  reject();
  expect(scanner.push("a|b", 14)).toBe(true);
  reject();
  expect(scanner.push("", 18)).toBe(true);
  reject();
  expect(scanner.push("c|d", 19)).toBe(true);
  expect(scanner.push("[bottom]", 23)).toBe(true);
  expect(scanner.finished).toBe(true);
  reject();
  expect(scanner.push("x|y", 32)).toBe(false);
  expect(scanner.finish()!.range).toEqual({ start: 10, end: 31 });

  const captioned = new TableScanner();
  captioned.push("[top]", 0);
  expect(captioned.push("no pipe", 6)).toBe(false);
  captioned.push("A|B", 6);
  expect(captioned.push("no pipe", 10)).toBe(false);
  captioned.push("-|-", 10);
  const before = captioned.finish();
  expect(captioned.push("[second]", 14)).toBe(false);
  expect(captioned.finish()).toEqual(before);
});

test("separator indentation follows four-column tab stops", () => {
  for (const indent of ["\t", " \t", "  \t", "   \t", "    "])
    expect(parseTable(`A|B\n${indent}-|-\nx|y`)).toBeNull();
  for (const indent of ["", " ", "  ", "   "])
    expect(parseTable(`A|B\n${indent}-|-\nx|y`)).not.toBeNull();
});

test("the upstream single-pipe separator does not restrict content width", () => {
  const table = parseTable("A|B\n|\nx|y")!;
  expect(table.columns).toEqual([]);
  expect(
    table.sections.map((section) =>
      section.rows[0]!.cells.map((cell) => cell.value),
    ),
  ).toEqual([
    ["A", "B"],
    ["x", "y"],
  ]);
  expect(parseTable("|", { headerless: true })).toBeNull();
  expect(parseTable("|\nx|y", { headerless: true })!.sections[0]!.kind).toBe(
    "body",
  );
});

test("zero-column separators integrate with GFM without changing fallback", () => {
  const normalize = (node: DefaultTreeAdapterMap["node"]): unknown => {
    if ("value" in node) return node.value.trim() ? node.value : null;
    return {
      name: node.nodeName,
      attrs: "attrs" in node ? node.attrs : [],
      children:
        "childNodes" in node
          ? node.childNodes.map(normalize).filter((child) => child !== null)
          : [],
    };
  };
  const base = unified().use(remarkParse).use(remarkGfm);
  const render = (withTable: boolean, source: string) => {
    const processor = base();
    if (withTable) processor.use(remarkMultimdTable);
    return String(
      processor.use(remarkRehype).use(rehypeStringify).processSync(source),
    );
  };
  expect(render(true, "A|B\n|\nx|y")).toBe(
    "<table><thead><tr><th>A</th><th>B</th></tr></thead><tbody><tr><td>x</td><td>y</td></tr></tbody></table>",
  );
  for (const source of [
    "A|B\n---|---\nx|y",
    "A|B\n \t-| -\nx|y",
    "plain\n|\ntext",
  ])
    expect(normalize(parseFragment(render(true, source)))).toEqual(
      normalize(parseFragment(render(false, source))),
    );
});

test("expanded sections preserve origin identity, holes and section boundaries", () => {
  const table = parseTable("A|B|C\n-|-|-\nx||z\n^^||w\n\n||tail", {
    rowspan: true,
  })!;
  const body = table.sections[1]!;
  const snapshot = structuredClone(body);
  const grid = expandSection(body);
  expect(grid.map((row) => row.map((cell) => cell?.value))).toEqual([
    ["x", "x", "z"],
    ["x", "x", "w"],
  ]);
  expect(grid[0]![0]!.inherited).toBe(false);
  for (const [r, c] of [
    [0, 1],
    [1, 0],
    [1, 1],
  ]) {
    expect(grid[r]![c]!.origin).toBe(body.rows[0]!.cells[0]!);
    expect(grid[r]![c]!.inherited).toBe(true);
  }
  expect(body).toEqual(snapshot);
  expect(
    expandSection(table.sections[2]!)[0]!.map((cell) => cell?.value ?? null),
  ).toEqual([null, "tail"]);
  expect(
    expandSection({ kind: "body", rows: [], range: { start: 0, end: 0 } }),
  ).toEqual([]);
});
