import { expect, test } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { Marked } from "marked";
import MarkdownIt from "markdown-it";
import { TableScanner } from "../src/core.js";
import { runtime } from "../src/internal/backend.js";
import remark from "../src/remark.js";
import marked from "../src/marked.js";
import markdownIt from "../src/markdown-it.js";
import { contractHash } from "./contracts.js";
import golden from "../../../contracts/core-contracts.json" with { type: "json" };

test("scanner allocates lazily, disposes idempotently and leaves returned models independent", () => {
  const scanner = new TableScanner();
  expect(runtime.activeScanners()).toBe(0);
  expect(scanner.finish()).toBeNull();
  expect(runtime.activeScanners()).toBe(0);
  scanner.push("A|B", 0);
  scanner.push("-|-", 4);
  expect(runtime.activeScanners()).toBe(1);
  const model = scanner.finish();
  const copy = structuredClone(model);
  scanner.dispose();
  scanner.dispose();
  expect(runtime.activeScanners()).toBe(0);
  expect(model).toEqual(copy);
  expect(() => scanner.push("x|y", 8)).toThrow("disposed");
  expect(() => scanner.finish()).toThrow("disposed");
});

test("scanner preserves safe host offsets, gaps, duplicate positions and snapshot independence", () => {
  const lines = ["[Title]", "A|B", "-|-", "|first|x|\\", "|last|y|"];
  const base = Number.MAX_SAFE_INTEGER - 64;
  for (const [caseIndex, offsets] of [
    [0, 8, 12, 16, 28],
    [0x1_0000_0000, 0x1_0000_0010, 0x1_0000_0020, 0x1_0000_0030, 0x1_0000_0040],
    [base, base + 8, base + 12, base + 20, base + 40],
    [40, 10, 10, 1, 20],
  ].entries()) {
    const scanner = new TableScanner({ multiline: true });
    try {
      for (let i = 0; i < lines.length; i++) {
        const accepted = scanner.push(lines[i]!, offsets[i]!);
        expect(contractHash({ accepted, model: scanner.finish() })).toBe(
          golden.scanners[caseIndex]![i]!,
        );
      }
      const first = scanner.finish()!;
      const expected = structuredClone(first);
      first.sections[0]!.rows[0]!.cells[0]!.segments[0]!.start = -1;
      expect(scanner.finish()).toEqual(expected);
    } finally {
      scanner.dispose();
    }
  }
});

test("scanner applies changed options to later pushes and model snapshots", () => {
  const scanner = new TableScanner();
  try {
    let offset = 0;
    for (const line of ["A|B", "-|-", "x||", "^^||"]) {
      scanner.push(line, offset);
      offset += line.length + 1;
    }
    for (const [index, rowspan] of [true, false, true].entries()) {
      scanner.options.rowspan = rowspan;
      expect(contractHash(scanner.finish())).toBe(golden.options[index]!);
    }
    scanner.options.autolabel = false;
    const accepted = scanner.push("[Caption]", offset);
    expect(contractHash({ accepted, model: scanner.finish() })).toBe(golden.options[3]!);
  } finally {
    scanner.dispose();
  }
});

test("invalid offsets fail before acquiring native resources", () => {
  const scanner = new TableScanner();
  for (const offset of [-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER]) {
    expect(() => scanner.push("A|B", offset)).toThrow(RangeError);
    expect(runtime.activeScanners()).toBe(0);
  }
  scanner.dispose();
});

test("all hosts release their own scanners on success, failed lookahead and exceptions", () => {
  const protectedScanner = new TableScanner();
  protectedScanner.push("A|B", 0);
  protectedScanner.push("-|-", 4);
  const renderers = [
    (source: string) =>
      String(
        unified()
          .use(remarkParse)
          .use(remark, { multiline: true })
          .use(remarkRehype)
          .use(rehypeStringify)
          .processSync(source),
      ),
    (source: string) => new Marked(marked({ multiline: true })).parse(source, { async: false }),
    (source: string) => new MarkdownIt().use(markdownIt, { multiline: true }).render(source),
  ];
  // oxlint-disable-next-line typescript/unbound-method -- 保存原型方法用于带 this 的生命周期探针。
  const push = TableScanner.prototype.push;
  try {
    for (const render of renderers) {
      for (const source of [
        "A|B\n-|-\nx|y",
        "candidate|header\nmore|text\nplain",
        "> A|B\n> -|-\n> x|y",
        "A|B\n-|-\n|one|two|\\\n|three|four|",
      ]) {
        expect(render(source)).toBeTruthy();
        expect(runtime.activeScanners()).toBe(1);
      }
      TableScanner.prototype.push = function (source, offset) {
        const accepted = push.call(this, source, offset);
        if (source.includes("THROW_HERE")) throw new Error("injected scanner failure");
        return accepted;
      };
      expect(() => render("A|B\n-|-\nTHROW_HERE|x")).toThrow("injected scanner failure");
      TableScanner.prototype.push = push;
      expect(runtime.activeScanners()).toBe(1);
      expect(protectedScanner.finish()).not.toBeNull();
    }
  } finally {
    TableScanner.prototype.push = push;
    protectedScanner.dispose();
  }
  expect(runtime.activeScanners()).toBe(0);
});
