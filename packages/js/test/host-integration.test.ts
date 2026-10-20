import { expect, test } from "vite-plus/test";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import remarkBreaks from "remark-breaks";
import remarkRehype from "remark-rehype";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import rehypeStringify from "rehype-stringify";
import remarkMultimd from "../src/remark.js";

const parser = () =>
  unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkMath)
    .use(remarkMultimd, { rowspan: true, multiline: true });

test("host math and GFM extensions survive merged and multiline cells", () => {
  const source =
    "| Math | Note |\n| --- | --- |\n| $x^2$ | ~~old~~ www.example.com |\n| ^^ | - first |\\\n| | - $y$ |";
  const tree = parser().parse(source);
  const types: string[] = [];
  function visit(node: { type: string; children?: unknown[] }) {
    types.push(node.type);
    for (const child of node.children || []) visit(child as Parameters<typeof visit>[0]);
  }
  visit(tree);
  expect(types.filter((type) => type === "inlineMath")).toHaveLength(2);
  expect(types).toContain("delete");
  expect(types).toContain("link");
  expect(types).toContain("list");
  expect(tree.children[0]?.type).toBe("multimdTable");
});

test("a structured-cloned parser result preserves renderer transforms", () => {
  const source = "before\nafter\n\nA|B\n-|-\n**one**||\n^^|two\n\n$z$";
  const p = parser().use(remarkBreaks).use(remarkRehype).use(rehypeStringify);
  const clone = structuredClone(p.parse(source));
  const fromWorker = String(p.stringify(p.runSync(clone)));
  const synchronous = String(p.processSync(source));
  expect(fromWorker).toBe(synchronous);
  expect(fromWorker).toContain("<br>");
  expect(fromWorker).toContain('colspan="2"');
  expect(fromWorker).toContain('rowspan="2"');
  expect(fromWorker).toContain("math-inline");
});

test("host raw HTML and sanitize policies apply inside extended tables", () => {
  const source =
    "A|B\n-|-\n<b onclick=alert(1)>safe</b>|<img src=javascript:alert(1) onerror=alert(1)>\n<script>alert(1)</script>|[bad](javascript:alert(1))";
  const html = String(
    parser()
      .use(remarkRehype, { allowDangerousHtml: true })
      .use(rehypeRaw)
      .use(rehypeSanitize)
      .use(rehypeStringify)
      .processSync(source),
  );
  expect(html).toContain("<b>safe</b>");
  expect(html).toContain("<table>");
  expect(html).not.toMatch(/onclick|onerror|javascript:|<script/);
});

test("worker-cloned block definitions resolve links and footnotes outside the table", () => {
  const source =
    "A|B\n-|-\n[r]: /safe|[r] [^n]|\\\n[^n]: Note|$x$|\\\nend|two|\n\nOutside [r] [^n]";
  const p = parser().use(remarkRehype).use(rehypeStringify);
  const tree = structuredClone(p.parse(source));
  const html = String(p.stringify(p.runSync(tree)));
  expect(html).toBe(String(p.processSync(source)));
  expect(html.match(/href="\/safe"/g)).toHaveLength(2);
  expect(html).toContain("data-footnotes");
  expect(html).toContain("math-inline");
});
