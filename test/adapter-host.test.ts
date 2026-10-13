import { expect, test } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkMultimd from "../src/remark.js";

const processor = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMultimd, { multiline: true })
    .use(remarkRehype)
    .use(rehypeStringify);

function nodes(tree: any, type: string): any[] {
  return [
    ...(tree.type === type ? [tree] : []),
    ...(tree.children || []).flatMap((child: any) => nodes(child, type)),
  ];
}

for (const before of [true, false]) {
  for (const block of [true, false]) {
    test(`GFM footnotes ${before ? "before" : "after"} table in ${block ? "block" : "inline"} cells`, () => {
      const definitions = "[^n]: Note\n\n[target]: /safe";
      const table = block
        ? "A|B\n-|-\n- foot[^n]|[target]|\\\n- again[^n]|next"
        : "A|B\n-|-\nfoot[^n]|[target]";
      const source = before ? definitions + "\n\n" + table : table + "\n\n" + definitions;
      const p = processor();
      const tree = p.parse(source);
      expect(nodes(tree, "footnoteDefinition")).toHaveLength(1);
      const calls = nodes(tree, "footnoteReference");
      expect(calls).toHaveLength(block ? 2 : 1);
      for (const call of calls) {
        expect(call.identifier).toBe("n");
        expect(source.slice(call.position.start.offset, call.position.end.offset)).toBe("[^n]");
      }
      expect(nodes(tree, "definition").map((n) => n.identifier)).toEqual(["target"]);
      const html = String(p.processSync(source));
      expect(html).toContain('href="/safe"');
      expect(html).toContain("data-footnote-ref");
      expect(html).toContain("data-footnotes");
      expect(html).not.toContain('href="Note"');
    });
  }
}

test("multiple tables share footnotes without leaking between documents", () => {
  const p = processor();
  const table = "A|B\n-|-\nx[^n]|[target]";
  const source = table + "\n\nbetween\n\n" + table + "\n\n[^n]: Note\n\n[target]: /safe";
  const tree = p.parse(source);
  expect(nodes(tree, "multimdTable")).toHaveLength(2);
  expect(nodes(tree, "footnoteReference")).toHaveLength(2);
  expect(nodes(tree, "footnoteDefinition")).toHaveLength(1);
  const next = p.parse(table);
  expect(nodes(next, "footnoteReference")).toHaveLength(0);
  expect(nodes(next, "linkReference")).toHaveLength(0);
  expect(nodes(p.parse(source), "footnoteReference")).toHaveLength(2);
});

test("blank table boundary restores native list and quote containers", () => {
  const html = String(processor().processSync("A|B\n-|-\nx|y\n\n- item\n\n> quote"));
  expect(html).toContain("<ul>");
  expect(html).toContain("<li>item</li>");
  expect(html).toContain("<blockquote>");
});

test("non-table GFM footnotes retain native rendering", () => {
  const source = "before[^n] and [target]\n\n[^n]: A **note**\n\n[target]: /safe";
  const expected = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(source),
  );
  expect(String(processor().processSync(source))).toBe(expected);
});

for (const eol of ["\n", "\r\n", "\r"]) {
  for (const container of ["plain", "quote", "list"] as const) {
    test(`adjacent footnote definitions keep native semantics in ${container} with ${JSON.stringify(eol)}`, () => {
      const lines = ["A|B", "-|-", "foot[^n]|[target]", "[^n]: Note", "", "[target]: /safe"];
      const source = lines
        .map((line, i) =>
          container === "quote"
            ? "> " + line
            : container === "list"
              ? (i ? "  " : "- ") + line
              : line,
        )
        .join(eol);
      const tree = processor().parse(source);
      expect(nodes(tree, "footnoteDefinition")).toHaveLength(1);
      const calls = nodes(tree, "footnoteReference");
      expect(calls).toHaveLength(1);
      expect(source.slice(calls[0].position.start.offset, calls[0].position.end.offset)).toBe(
        "[^n]",
      );
      expect(nodes(tree, "definition").map((n) => n.identifier)).toEqual(["target"]);
    });
  }
}

for (const quote of [false, true]) {
  test(`multibody keeps literal list and quote cells after a gap${quote ? " inside a quote" : ""}`, () => {
    const lines = ["A|B", "-|-", "x|y", "", "- literal|x", "> literal|y"];
    const source = lines.map((line) => (quote ? "> " + line : line)).join("\r\n");
    const tree = processor().parse(source);
    expect(nodes(tree, "multimdTable")).toHaveLength(1);
    expect(nodes(tree, "multimdSection").filter((n) => n.data.hName === "tbody")).toHaveLength(2);
    expect(nodes(tree, "list")).toHaveLength(0);
    expect(nodes(tree, "blockquote")).toHaveLength(quote ? 1 : 0);
    const texts = nodes(tree, "text");
    for (const value of ["- literal", "> literal"]) {
      const text = texts.find((n) => n.value === value);
      expect(text).toBeDefined();
      expect(source.slice(text.position.start.offset, text.position.end.offset)).toBe(value);
    }
  });
}

test("source lookahead does not turn escaped or code-span pipes into table rows", () => {
  const source = "A|B\n-|-\nx|y\n- escaped \\|\n\n> code `|`";
  const tree = processor().parse(source);
  expect(nodes(tree, "multimdRow")).toHaveLength(2);
  expect(nodes(tree, "list")).toHaveLength(1);
  expect(nodes(tree, "blockquote")).toHaveLength(1);
});

test("a later parser override may return a worker-parsed tree", () => {
  const parsed = processor().parse("A|B\n-|-\nx[^n]|y\n[^n]: Note");
  const p = processor().use(function () {
    this.parser = () => parsed;
  });
  expect(p.parse("worker result")).toBe(parsed);
  expect(String(p.processSync("worker result"))).toContain("data-footnote-ref");
});

test("lookahead respects the end of an outer quote without a blank line", () => {
  const source = "> A|B\n> -|-\n> x[^n]|y\n[^n]: Note";
  const tree = processor().parse(source);
  expect(nodes(tree, "footnoteReference")).toHaveLength(1);
  expect(tree.children.map((n) => n.type)).toEqual(["blockquote", "footnoteDefinition"]);
  expect(nodes(tree.children[0], "multimdTable")).toHaveLength(1);
});

test("empty lines and EOF preserve table segments without empty tokens", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    for (const ending of ["", eol, eol + eol]) {
      const source = ["A|B", "-|-", "x| ", "", "y|z"].join(eol) + ending;
      const tree = processor().parse(source);
      const tables = nodes(tree, "multimdTable");
      expect(tables).toHaveLength(1);
      expect(tables[0].model.sections).toHaveLength(3);
      expect(nodes(tree, "text").map((n) => n.value)).toEqual(["A", "B", "x", "y", "z"]);
      for (const cell of nodes(tree, "multimdCell")) {
        expect(cell.position.start.offset).toBeGreaterThanOrEqual(0);
        expect(cell.position.end.offset).toBeLessThanOrEqual(source.length);
      }
    }
  }
});

test("block-cell definitions resolve in other cells, earlier tables and outside text", () => {
  const source = [
    "A|B",
    "-|-",
    "[r]|first",
    "",
    "between",
    "",
    "A|B",
    "-|-",
    "[r]: /safe|[r]|\\",
    "text|two|",
    "",
    "Outside [r]",
  ].join("\n");
  const p = processor();
  const tree = p.parse(source);
  expect(nodes(tree, "linkReference")).toHaveLength(3);
  expect(nodes(tree, "definition")).toHaveLength(1);
  for (const link of nodes(tree, "linkReference"))
    expect(source.slice(link.position.start.offset, link.position.end.offset)).toBe("[r]");
  expect(String(p.processSync(source)).match(/href="\/safe"/g)).toHaveLength(3);
});

test("definitions nested in block cells share the document scope", () => {
  const source = "A|B\n-|-\n> [r]: /nested|[r]|\\\n> content|two|\n\nOutside [r]";
  const tree = processor().parse(source);
  expect(nodes(tree, "blockquote")).toHaveLength(1);
  expect(nodes(tree, "linkReference")).toHaveLength(2);
  expect(String(processor().processSync(source)).match(/href="\/nested"/g)).toHaveLength(2);
});

for (const outerFirst of [true, false]) {
  test(`duplicate cell and outer definitions preserve source precedence: outer ${outerFirst ? "first" : "last"}`, () => {
    const table = "A|B\n-|-\n[r]: /cell|[r]|\\\ntext|two|";
    const outer = "[r]: /outer";
    const source =
      (outerFirst ? outer + "\n\n" + table : table + "\n\n" + outer) + "\n\nOutside [r]";
    const html = String(processor().processSync(source));
    const preferred = outerFirst ? "outer" : "cell";
    expect(html.match(new RegExp(`href="/${preferred}"`, "g"))).toHaveLength(2);
  });
}

test("duplicate definitions in different cells use the first definition", () => {
  const source = "A|B\n-|-\n[r]: /first|[r]: /second|\\\n[r]|[r]|\n\nOutside [r]";
  const html = String(processor().processSync(source));
  expect(html.match(/href="\/first"/g)).toHaveLength(3);
  expect(html).not.toContain('href="/second"');
});

test("cell footnotes and links keep separate identifier namespaces", () => {
  const source =
    "A|B\n-|-\n[r]: /safe|[r] [^r]|\\\n[^r]: Note|more|\\\ntail|end|\n\nOutside [r] [^r]";
  const p = processor();
  const tree = p.parse(source);
  expect(nodes(tree, "definition")).toHaveLength(1);
  expect(nodes(tree, "footnoteDefinition")).toHaveLength(1);
  expect(nodes(tree, "linkReference")).toHaveLength(2);
  expect(nodes(tree, "footnoteReference")).toHaveLength(2);
  const html = String(p.processSync(source));
  expect(html.match(/href="\/safe"/g)).toHaveLength(2);
  expect(html).toContain("data-footnotes");
  expect(nodes(p.parse("Outside [r] [^r]"), "linkReference")).toHaveLength(0);
  expect(nodes(p.parse("Outside [r] [^r]"), "footnoteReference")).toHaveLength(0);
});

test("multiline duplicate definitions follow upstream cell parsing order", () => {
  // 多行块按单元格逐格解析；原插件先读取左格，再读取右格，而非按物理行排序。
  const source = "A|B\n-|-\n |[r]: /first|\\\n[r]: /second|text|\n\nOutside [r]";
  const html = String(processor().processSync(source));
  expect(html).toContain('<p>Outside <a href="/second">r</a></p>');
});

test("only new cell definitions trigger a second parse and exceptions restore seeds", () => {
  let calls = 0;
  let failAt = 0;
  const p = unified()
    .use(remarkParse)
    .use(function () {
      const parse = this.parser!;
      this.parser = (source, file) => {
        calls++;
        if (calls === failAt) throw new Error("host parser failure");
        return parse(source, file);
      };
    })
    .use(remarkGfm)
    .use(remarkMultimd, { multiline: true });
  p.parse("A|B\n-|-\nx|y");
  expect(calls).toBe(1);
  const source = "A|B\n-|-\n[r]: /safe|[r]|\\\ntext|two|";
  p.parse(source);
  expect(calls).toBe(3);
  failAt = calls + 2;
  expect(() => p.parse(source)).toThrow("host parser failure");
  expect(calls).toBe(5);
  const next = p.parse("Outside [r]");
  expect(calls).toBe(6);
  expect(nodes(next, "linkReference")).toHaveLength(0);
  expect(nodes(p.parse(source), "linkReference")).toHaveLength(1);
  expect(calls).toBe(8);
  p.parse("[r]: /outer\n\n" + source);
  expect(calls).toBe(9);
});
