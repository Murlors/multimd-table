import { expect, test } from "vite-plus/test";
import { compile, createProcessor, evaluate, run, type CompileOptions } from "@mdx-js/mdx";
import React, { type ComponentProps, type JSX as ReactJSX } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import type { MDXComponents, MDXModule } from "mdx/types.js";
import type { Node } from "unist";
import remarkGfm from "remark-gfm";
import remarkMultimdTable from "../src/remark.js";
import type { Table } from "../src/core.js";

// @types/mdx 2 读取全局 JSX；测试实际采用 React 19 的 JSX runtime，按对应类型绑定。
declare global {
  namespace JSX {
    type ElementType = ReactJSX.ElementType;
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}

const remarkPlugins: NonNullable<CompileOptions["remarkPlugins"]> = [
  remarkGfm,
  [remarkMultimdTable, { rowspan: true, multiline: true }],
];
type HtmlNode = DefaultTreeAdapterTypes.Node;
type HtmlElement = DefaultTreeAdapterTypes.Element;
type AstNode = Node & { children?: AstNode[]; value?: string; model?: Table };

function elements(node: HtmlNode, tagName: string): HtmlElement[] {
  const result: HtmlElement[] = [];
  if ("tagName" in node && node.tagName === tagName) result.push(node);
  if ("childNodes" in node)
    for (const child of node.childNodes) result.push(...elements(child, tagName));
  return result;
}
function textContent(node: HtmlNode): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}
function attribute(node: HtmlElement, name: string): string | undefined {
  return node.attrs.find((attribute) => attribute.name === name)?.value;
}
function astNodes(node: AstNode, type: string): AstNode[] {
  return [
    ...(node.type === type ? [node] : []),
    ...(node.children || []).flatMap((child) => astNodes(child, type)),
  ];
}
function render(module: MDXModule, components?: MDXComponents) {
  return parseFragment(renderToStaticMarkup(React.createElement(module.default, { components })));
}

// 仅求值本文件内固定、可信的测试源码；插件接入不改变 MDX 的执行边界。
async function renderMdx(source: string, components?: MDXComponents) {
  return render(await evaluate(source, { ...runtime, remarkPlugins }), components);
}

function Badge({ children, label }: { children?: React.ReactNode; label?: string }) {
  return React.createElement("span", { "data-badge": label || "inline" }, children || label);
}

test("compiled MDX renders native caption, merged cells, JSX components and expressions", async () => {
  const source = [
    "export const amount = 7",
    "",
    "[Totals **now**][totals]",
    "| Group || Result |",
    "|:---|---:|---:|",
    '| <Badge label="alpha" /> || {amount + 1} |',
    "| ^^ || ~~old~~ |",
  ].join("\n");
  const code = await compile(source, { remarkPlugins, outputFormat: "function-body" });
  const module = await run(code, runtime);
  const html = render(module, { Badge });
  expect(module.amount).toBe(7);
  expect(elements(html, "table")).toHaveLength(1);
  const caption = elements(html, "caption")[0]!;
  expect(attribute(caption, "id")).toBe("totals");
  expect(textContent(elements(caption, "strong")[0]!)).toBe("now");
  const heading = elements(html, "th")[0]!;
  expect(attribute(heading, "colspan")).toBe("2");
  expect(attribute(heading, "style")).toBe("text-align:left");
  const cells = elements(html, "td");
  expect(cells).toHaveLength(3);
  expect(attribute(cells[0]!, "colspan")).toBe("2");
  expect(attribute(cells[0]!, "rowspan")).toBe("2");
  expect(attribute(elements(cells[0]!, "span")[0]!, "data-badge")).toBe("alpha");
  expect(textContent(cells[1]!)).toBe("8");
  expect(textContent(elements(cells[2]!, "del")[0]!)).toBe("old");
});

test("multiline block cells compile JSX, expressions and GFM lists with source positions", async () => {
  const source = [
    "A|B",
    "-|-",
    "<Badge>|- [x] first|\\",
    "{1 + 2}|- [ ] second|\\",
    "</Badge>|tail|",
    "[After][after]",
  ].join("\r\n");
  const processor = createProcessor({ remarkPlugins });
  const tree = processor.parse(source);
  const table = astNodes(tree, "multimdTable")[0]!;
  const cell = table.model!.sections[1]!.rows[0]!.cells[0]!;
  expect(cell.block).toBe(true);
  expect(cell.segments.map(({ start, end }) => source.slice(start, end)).join("\n")).toBe(
    cell.value,
  );
  for (const [type, expected] of [
    ["mdxFlowExpression", "{1 + 2}"],
    ["mdxJsxFlowElement", "<Badge>"],
  ]) {
    const node = astNodes(table, type!)[0]!;
    expect(node).toBeDefined();
    expect(source.slice(node.position!.start.offset!, node.position!.end.offset!)).toContain(
      expected!,
    );
  }
  const rendered = await renderMdx(source, { Badge });
  const cells = elements(rendered, "td");
  expect(textContent(elements(cells[0]!, "span")[0]!)).toBe("3");
  expect(elements(cells[1]!, "li").map(textContent)).toEqual([" first", " second\ntail"]);
  expect(elements(cells[1]!, "input").map((input) => attribute(input, "type"))).toEqual([
    "checkbox",
    "checkbox",
  ]);
  expect(elements(cells[1]!, "input").map((input) => attribute(input, "checked"))).toEqual([
    "",
    undefined,
  ]);
  const caption = elements(rendered, "caption")[0]!;
  expect(attribute(caption, "id")).toBe("after");
  expect(attribute(caption, "style")).toBe("caption-side:bottom");
});

test("MDX component overrides receive table spans, alignment and children", async () => {
  const headers: ComponentProps<"th">[] = [];
  const cells: ComponentProps<"td">[] = [];
  const components: MDXComponents = {
    th(props: ComponentProps<"th">) {
      headers.push(props);
      return React.createElement("th", { ...props, "data-custom": "header" });
    },
    td(props: ComponentProps<"td">) {
      cells.push(props);
      return React.createElement("td", { ...props, "data-custom": "cell" });
    },
  };
  const html = await renderMdx("| A ||\n|:---|---:|\n| **B** ||\n| ^^ ||", components);
  expect(headers).toHaveLength(1);
  expect(Number(headers[0]!.colSpan)).toBe(2);
  expect(headers[0]!.style).toEqual({ textAlign: "left" });
  expect(cells).toHaveLength(1);
  expect(Number(cells[0]!.colSpan)).toBe(2);
  expect(Number(cells[0]!.rowSpan)).toBe(2);
  const renderedCell = elements(html, "td")[0]!;
  expect(attribute(renderedCell, "data-custom")).toBe("cell");
  expect(attribute(renderedCell, "colspan")).toBe("2");
  expect(attribute(renderedCell, "rowspan")).toBe("2");
  expect(textContent(elements(renderedCell, "strong")[0]!)).toBe("B");
});

test("one MDX processor resolves GFM references per document without leaking definitions", async () => {
  const processor = createProcessor({ remarkPlugins, outputFormat: "function-body" });
  const source = [
    "A|B",
    "-|-",
    "~~old~~ [link][ref]|note[^note]",
    "",
    "[ref]: /first",
    "[^note]: First note",
  ].join("\n");
  const first = render(await run(await processor.process(source), runtime));
  expect(elements(first, "a").some((link) => attribute(link, "href") === "/first")).toBe(true);
  expect(
    elements(first, "a").some((link) => attribute(link, "data-footnote-ref") !== undefined),
  ).toBe(true);
  expect(textContent(elements(first, "del")[0]!)).toBe("old");
  const second = render(
    await run(await processor.process("A|B\n-|-\n| [link][ref] | [^note] |"), runtime),
  );
  expect(elements(second, "a")).toHaveLength(0);
  expect(elements(second, "section")).toHaveLength(0);
  expect(elements(second, "td").map(textContent)).toEqual(["[link][ref]", "[^note]"]);
  const third = render(
    await run(await processor.process(source.replace("/first", "/third")), runtime),
  );
  expect(elements(third, "a").filter((link) => attribute(link, "href") === "/third")).toHaveLength(
    1,
  );
});

test("MDX block-cell definitions resolve in other cells and surrounding Markdown", async () => {
  const source = [
    "A|B",
    "-|-",
    "[ref]: /cell|[ref] [^note]|\\",
    "[^note]: Inner note|last|",
    "",
    "Outside [ref] [^note]",
  ].join("\n");
  const html = await renderMdx(source);
  expect(elements(html, "a").filter((link) => attribute(link, "href") === "/cell")).toHaveLength(2);
  expect(
    elements(html, "a").filter((link) => attribute(link, "data-footnote-ref") !== undefined),
  ).toHaveLength(2);
  const footnotes = elements(html, "section").filter(
    (section) => attribute(section, "data-footnotes") !== undefined,
  );
  expect(footnotes).toHaveLength(1);
  expect(textContent(footnotes[0]!)).toContain("Inner note");
});

test("MDX keeps native JSX and expression syntax boundaries inside cells", async () => {
  const source = "A|B\n-|-\n<em title={String(2)}>html</em>|{1 + 1}\n`<Badge/>`|\\{literal\\}";
  const html = await renderMdx(source);
  expect(attribute(elements(html, "em")[0]!, "title")).toBe("2");
  expect(elements(html, "td").map(textContent)).toEqual(["html", "2", "<Badge/>", "{literal}"]);
  for (const invalid of [
    "A|B\n-|-\n<br>|text",
    "A|B\n-|-\n<!-- html comment -->|text",
    "A|B\n-|-\n{1 +}|text",
  ]) {
    await expect(compile(invalid, { remarkPlugins })).rejects.toThrow();
  }
});
