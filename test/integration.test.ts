import { test, expect } from "bun:test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { parseFragment } from "parse5";
import remarkMultimdTable from "../src/remark.js";
import { parseTable, expandSection, type Options } from "../src/core.js";
import { syntaxCases, optionCases } from "./cases.js";
const make = (options: Options = {}) =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMultimdTable, {
      ...options,
    })
    .use(remarkRehype)
    .use(rehypeStringify);
function canonical(html: string): unknown {
  const walk = (n: any, pre = false): any =>
    n.nodeName === "#text"
      ? pre
        ? n.value
        : n.value.trim() || null
      : {
          tag: n.tagName || n.nodeName,
          attrs: [...(n.attrs || [])].sort((a: any, b: any) => a.name.localeCompare(b.name)),
          children: (n.childNodes || [])
            .map((c: any) => walk(c, pre || n.tagName === "pre"))
            .filter((c: any) => c !== null),
        };
  return walk(parseFragment(html));
}
for (const { name, source, html, options } of syntaxCases) {
  test(`remark syntax: ${name}`, () => {
    expect(canonical(String(make(options).processSync(source)))).toEqual(canonical(html));
  });
}
for (let flags = 0; flags < 32; flags++) {
  const options: Required<Options> = {
    multiline: !!(flags & 1),
    rowspan: !!(flags & 2),
    headerless: !!(flags & 4),
    multibody: !!(flags & 8),
    autolabel: !!(flags & 16),
  };
  test(`all option combinations ${flags}`, () => {
    for (const { source, html } of optionCases(options)) {
      expect(canonical(String(make(options).processSync(source)))).toEqual(canonical(html));
    }
  });
}
test("non-table Markdown and fenced examples retain host behavior", () => {
  const source =
    "# Heading\n\nparagraph | literal\n\n- item\n  - nested\n\n> quote\n\n```md\nA|B\n-|-\na|b\n```\n\n---\n\n[link](https://example.com)";
  const base = String(
    unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(source),
  );
  expect(String(make().processSync(source))).toBe(base);
});
test("unsuccessful table lookahead preserves immediate block boundaries", () => {
  for (const source of [
    "text | pipe\n- list\n",
    "text | pipe\n> quote\n",
    "text | pipe\n# heading\n",
    "a|b\nc|d\n- list\n",
  ]) {
    const base = String(
      unified()
        .use(remarkParse)
        .use(remarkGfm)
        .use(remarkRehype)
        .use(rehypeStringify)
        .processSync(source),
    );
    expect(String(make().processSync(source))).toBe(base);
  }
});
test("blockquote tables, surrounding paragraphs, references and GFM cells", () => {
  const source = "before\n\n> A|B\n> -|-\n> ~~old~~|[link][x]\n\nafter\n\n[x]: https://example.com";
  const expected = '<p>before</p><blockquote><table><thead><tr><th>A</th><th>B</th></tr></thead>' +
    '<tbody><tr><td><del>old</del></td><td><a href="https://example.com">link</a></td></tr></tbody>' +
    '</table></blockquote><p>after</p>';
  expect(canonical(String(make().processSync(source)))).toEqual(canonical(expected));
});
test("ReactMarkdown renders native merged elements without raw HTML", () => {
  const source = "A|B\n-|-\nx||\n^^||";
  const html = renderToStaticMarkup(
    React.createElement(ReactMarkdown, {
      remarkPlugins: [
        remarkGfm,
        [
          remarkMultimdTable,
          {
            rowspan: true,
          },
        ],
      ],
      children: source,
    }),
  );
  expect(html).toContain('colSpan="2"');
  expect(html).toContain('rowSpan="2"');
  expect(html).not.toContain("^^");
});
test("Unicode, lone surrogates, CRLF and source segments match exactly", () => {
  for (const eol of ["\n", "\r\n", "\r"]) {
    const source = [
      "[标题😀]",
      "| 名称 | 值 |",
      "|---|---|",
      "| 华东😀\ud800 | é |",
      "| ^^ | \udfff |",
    ].join(eol);
    const ts = parseTable(source, { rowspan: true })!;
    for (const s of ts.sections)
      for (const r of s.rows)
        for (const c of r.cells)
          expect(c.segments.map((p) => source.slice(p.start, p.end)).join("\n")).toBe(c.value);
  }
});
test("mdast positions stay on source after nested and multiline parsing", () => {
  const source =
    "> A|B\r\n> -|-\r\n> 中文😀|**粗体**\r\n\r\nC|D\r\n-|-\r\nfirst|one|\\\r\nsecond|two|";
  const tree = unified()
    .use(remarkParse)
    .use(remarkMultimdTable, {
      multiline: true,
    })
    .parse(source);
  function visit(n: any) {
    if (n.type === "text" && ["中文😀", "粗体", "first\nsecond", "one\ntwo"].includes(n.value)) {
      expect(n.position.start.offset).toBeGreaterThanOrEqual(0);
      const slice = source.slice(n.position.start.offset, n.position.end.offset);
      if (!n.value.includes("\n")) expect(slice).toBe(n.value);
    }
    for (const c of n.children || []) visit(c);
  }
  visit(tree);
});
test("expanded data retains origin identity and section boundaries", () => {
  const model = parseTable("A|B\n-|-\nx|1\n^^|2\n\ny|3", { rowspan: true })!;
  const grid = expandSection(model.sections[1]!);
  expect(grid[1]![0]!.origin).toBe(grid[0]![0]!.origin);
  expect(grid[1]![0]!.inherited).toBe(true);
  expect(model.sections[2]!.rows[0]!.cells[0]!.value).toBe("y");
});
test("deterministic generated valid tables preserve complete source segments", () => {
  let seed = 20261013;
  const values = ["华东😀", "\\|", "`x|y`", "**bold**", "^^", " ", "A", "\ud800"];
  for (let n = 0; n < 160; n++) {
    const rows = ["A|B|C", "---|:---:|---:"];
    for (let i = 0; i < n % 21; i++) {
      const cells = [];
      for (let c = 0; c < 3; c++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        cells.push(values[seed % values.length]);
      }
      rows.push("| " + cells.join(" | ") + " |");
    }
    const source = rows.join("\n");
    const options = { rowspan: !!(n % 2) };
    const table = parseTable(source, options)!;
    expect(table).not.toBeNull();
    for (const section of table.sections)
      for (const row of section.rows)
        for (const cell of row.cells)
          expect(cell.segments.map(({ start, end }) => source.slice(start, end)).join("\n")).toBe(
            cell.value,
          );
  }
});
test("long invalid pipe paragraphs and unterminated continuations stay intact", () => {
  const invalid = Array.from({ length: 2000 }, (_, i) => `row ${i}|value ${i}`).join("\n");
  {
    const html = String(make().processSync(invalid));
    expect(html.startsWith("<p>row 0|value 0")).toBe(true);
    expect(html).not.toContain("<table>");
    expect(html).toContain("row 1999|value 1999");
  }
  const source = "A|B\n-|-\n" + Array.from({ length: 2000 }, () => "x|y|\\").join("\n");
  const ts = parseTable(source, { multiline: true })!;
  expect(ts.sections[1]!.rows.length).toBe(2000);
});
