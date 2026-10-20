import { expect, test } from "vite-plus/test";
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

test("references remain available in every inline cell and multiline block", () => {
  const source = [
    "A|B",
    "-|-",
    ...Array.from({ length: 40 }, (_, i) => `|[label][r${i}]|[missing]|`),
    "- [first][r0]|~~old~~|\\",
    "- [last][r39]|[label][r20]",
    "",
    ...Array.from({ length: 40 }, (_, i) => `[r${i}]: /target/${i}`),
  ].join("\n");
  const html = String(processor().processSync(source));
  for (let i = 0; i < 40; i++) expect(html).toContain(`<a href="/target/${i}">label</a>`);
  expect(html.match(/\[missing\]/g)).toHaveLength(40);
  expect(html).toContain('<li><a href="/target/0">first</a></li>');
  expect(html).toContain('<li><a href="/target/39">last</a></li>');
  expect(html).toContain("<del>old</del>");
});

test("processor reuse keeps reference definitions local to each document", () => {
  const p = processor();
  const table = "A|B\n-|-\n|[x]|[missing]|\n";
  expect(String(p.processSync(table + "\n[x]: /first"))).toContain('<a href="/first">x</a>');
  const withoutDefinitions = String(p.processSync(table));
  expect(withoutDefinitions).toContain("<td>[x]</td>");
  expect(withoutDefinitions).not.toContain("<a ");
  expect(String(p.processSync(table + "\n[x]: /second"))).toContain('<a href="/second">x</a>');
});

test("committed tables keep list and quote markers inside later cells", () => {
  const html = String(processor().processSync("A|B\n-|-\nx|y\n- literal|> literal\n# literal|z"));
  expect(html).toContain("<td>- literal</td>");
  expect(html).toContain("<td>> literal</td>");
  expect(html).toContain("<td># literal</td>");
  expect(html).not.toContain("<blockquote>");
});
