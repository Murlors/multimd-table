import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import MarkdownIt from "markdown-it";
import { parseFragment, type DefaultTreeAdapterMap } from "parse5";
import markdownItMultimdTable from "../src/markdown-it.js";
import type { Options } from "../src/core.js";
import { renderReference } from "./reference.js";

function normalize(html: string): unknown {
  const walk = (node: DefaultTreeAdapterMap["node"], pre = false): unknown => {
    if ("value" in node)
      return pre
        ? node.value
        : node.value.trim()
          ? node.value.replace(/\s+/g, " ").trim()
          : null;
    return {
      tag: node.nodeName,
      attrs:
        "attrs" in node
          ? [...node.attrs].sort((a, b) => a.name.localeCompare(b.name))
          : [],
      children:
        "childNodes" in node
          ? node.childNodes
              .map((child) => walk(child, pre || node.nodeName === "pre"))
              .filter((child) => child !== null)
          : [],
    };
  };
  return walk(parseFragment(html));
}

for (const file of ["standard", "options", "unspecified"]) {
  const options: Options =
    file === "options"
      ? {
          multiline: true,
          rowspan: true,
          headerless: true,
          multibody: false,
          autolabel: false,
        }
      : {};
  const parts = readFileSync(
    new URL(`./fixtures/${file}.txt`, import.meta.url),
    "utf8",
  ).split(/^\.\r?$/m);
  for (let index = 0; index + 2 < parts.length; index += 3) {
    const title = parts[index]!.trim().split("\n").at(-1)!;
    const source = parts[index + 1]!.replace(/^\n/, "");
    const expected = parts[index + 2]!.trim();
    test(`markdown-it ${file}: ${title}`, () => {
      const actual = new MarkdownIt().use(markdownItMultimdTable, options).render(source);
      expect(normalize(actual)).toEqual(normalize(expected));
      expect(normalize(actual)).toEqual(normalize(renderReference(source, options)));
    });
  }
}

const optionSamples = [
  "[Sales][report]\n| Region | 2026 ||\n| Name | Qty | Revenue |\n|:---|---:+|===:|\n| 华东😀 | 3 | 90 |\n| ^^ | 5 | 150 |\n\n| 华南 | 8 ||\n[After]",
  "|--|--|\n| A ||\n| ^^ ||\n[说明]",
  "A|B\n-|-\n- one|`a|b`|\\\n- two|**bold**|\nnext|\\^^|",
];
for (let flags = 0; flags < 32; flags++) {
  const options: Options = {
    multiline: !!(flags & 1),
    rowspan: !!(flags & 2),
    headerless: !!(flags & 4),
    multibody: !!(flags & 8),
    autolabel: !!(flags & 16),
  };
  test(`markdown-it all option combinations ${flags}`, () => {
    const md = new MarkdownIt().use(markdownItMultimdTable, options);
    for (const source of optionSamples)
      expect(normalize(md.render(source))).toEqual(normalize(renderReference(source, options)));
  });
}

test("markdown-it renderer overrides and inline/core plugins receive native table tokens", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  md.inline.ruler.before("link", "custom_inline", (state, silent) => {
    if (!state.src.startsWith("[[custom]]", state.pos)) return false;
    if (!silent) state.push("custom_inline", "mark", 0).content = "custom";
    state.pos += "[[custom]]".length;
    return true;
  });
  md.renderer.rules.custom_inline = (tokens, index) => `<mark>${tokens[index]!.content}</mark>`;
  md.renderer.rules.td_open = (tokens, index, options, _env, renderer) => {
    tokens[index]!.attrJoin("class", "host-cell");
    return renderer.renderToken(tokens, index, options);
  };
  let inlineBlocks = 0;
  md.core.ruler.after("inline", "host_transform", (state) => {
    for (const token of state.tokens) {
      if (token.type !== "inline") continue;
      inlineBlocks++;
      for (const child of token.children || [])
        if (child.type === "text") child.content = child.content.replace(/before/g, "after");
    }
  });
  const html = md.render("[before [[custom]]]\nA|B\n-|-\n[[custom]]|before\n- [[custom]]|before|\\\n- **bold**|before|");
  expect(html.match(/<mark>custom<\/mark>/g)).toHaveLength(3);
  expect(html.match(/class="host-cell"/g)).toHaveLength(4);
  expect(html).not.toContain(">before");
  expect(html).toContain("<strong>bold</strong>");
  expect(inlineBlocks).toBe(8);
});

test("markdown-it references are resolved after the complete block pass, including cell definitions", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  const source = "A|B\n-|-\n|[late]|[cell]|\n|[cell]: /cell|[late]|\\\n| |[cell]|\n\nOutside [cell] [late]\n\n[late]: /later";
  const html = md.render(source);
  expect(html.match(/href="\/cell"/g)).toHaveLength(3);
  expect(html.match(/href="\/later"/g)).toHaveLength(3);
  expect(html).not.toContain("[cell]:");
  expect(html).toContain("<p>Outside <a");
});

test("markdown-it parser reuse follows the host env scope", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  const table = "A|B\n-|-\n[x]|plain";
  expect(md.render(`${table}\n\n[x]: /one`)).toContain('href="/one"');
  expect(md.render(table)).toContain("<td>[x]</td>");
  expect(md.render(`${table}\n\n[x]: /two`)).toContain('href="/two"');
  const env = {};
  md.render("A|B\n-|-\n[x]: /shared|plain|\\\n|plain|", env);
  expect(md.render(table, env)).toContain('href="/shared"');
  expect(md.render(table, {})).toContain("<td>[x]</td>");
});

test("markdown-it preserves table rule toggles in CommonMark and default presets", () => {
  const source = "A|B\n-|-\nx||\n^^||";
  const commonmark = new MarkdownIt("commonmark").use(markdownItMultimdTable, { rowspan: true });
  expect(commonmark.render(source)).toBe(new MarkdownIt("commonmark").render(source));
  expect(commonmark.enable("table").render(source)).toContain('rowspan="2"');
  expect(commonmark.disable("table").render(source)).not.toContain("<table>");
  expect(new MarkdownIt().disable("table").use(markdownItMultimdTable).render(source))
    .not.toContain("<table>");
});

test("markdown-it malformed lookahead and outer fenced/code blocks retain host behavior", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable);
  const base = new MarkdownIt();
  for (const source of [
    "literal | pipe\n- list\n",
    "literal | pipe\n> quote\n",
    "literal | pipe\n# heading\n",
    "a|b\nc|d\n- list\n",
    "```md\nA|B\n-|-\nx|y\n```",
    "    A|B\n    -|-\n    x|y",
    "\tA|B\n\t-|-\n\tx|y",
    "plain|literal\n",
  ]) expect(md.render(source)).toBe(base.render(source));
  const source = "A|B\n-|-\nx|y\n```md\noutside|pipe\n```\n\n# Heading";
  expect(md.render(source)).toContain('<pre><code class="language-md">outside|pipe\n</code></pre>');
  expect(md.render(source)).toContain("<h1>Heading</h1>");
});

test("markdown-it container boundaries and Tab expansion preserve cells and source maps", () => {
  const source = "before\n\n> - list\n>\n>   [title]\n>   A|B\n>   -|-\n>   - one|first|\\\n>   - two|second|\n>\n>   x|y\n\nafter";
  const md = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  expect(normalize(md.render(source))).toEqual(normalize(renderReference(source, { multiline: true })));
  const tokens = md.parse(source, {});
  expect(tokens.find((token) => token.type === "table_open")?.map).toEqual([4, 11]);
  expect(tokens.find((token) => token.type === "caption_open")?.map).toEqual([4, 5]);
  expect(tokens.filter((token) => token.type === "tbody_open").map((token) => token.map))
    .toEqual([[7, 9], [10, 11]]);
  expect(tokens.find((token) => token.type === "inline" && token.content === "one")?.map)
    .toEqual([7, 8]);
  let level = 0;
  for (const token of tokens) {
    if (token.nesting === -1) level--;
    expect(token.level).toBe(level);
    if (token.nesting === 1) level++;
  }
  expect(level).toBe(0);
  const tabList = "- item\n\n\tA|B\n\t-|-\n\tx|y";
  expect(normalize(md.render(tabList))).toEqual(normalize(new MarkdownIt().render(tabList)));
});

test("markdown-it preserves Tab code indentation at the start of a candidate table", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable);
  const base = new MarkdownIt();
  for (const prefix of ["", " ", "  ", "   "]) {
    const source = `${prefix}\tA|B\n-|-\nx|y`;
    expect(md.render(source)).toBe(base.render(source));
    expect(md.render(source)).toContain("<pre><code>");
    const middle = `A|B\n${prefix}\tC|D\n-|-\nx|y`;
    expect(md.render(middle)).toBe(base.render(middle));
    expect(md.render(middle)).not.toContain("<table>");
    for (const nested of [
      `> ${prefix}\tA|B\n> -|-\n> x|y`,
      `- item\n\n  ${prefix}\tA|B\n  -|-\n  x|y`,
    ]) {
      const html = md.render(nested);
      expect(html).toBe(base.render(nested));
      expect(html).toContain(prefix.length < 2 ? "<table>" : "<pre><code>");
    }
    if (prefix.length >= 2)
      for (const nested of [
        `> A|B\n> ${prefix}\tC|D\n> -|-\n> x|y`,
        `- item\n\n  A|B\n  ${prefix}\tC|D\n  -|-\n  x|y`,
      ]) {
        expect(md.render(nested)).toBe(base.render(nested));
        expect(md.render(nested)).not.toContain("<table>");
      }
  }
  for (const source of [
    ">   \tA|B\n> -|-\n> x|y",
    "- item\n\n  \t\tA|B\n  -|-\n  x|y",
    "> - item\n>\n>     \tA|B\n>   -|-\n>   x|y",
  ]) expect(md.render(source)).toBe(base.render(source));
  expect(md.render("    A|B\n-|-\nx|y")).toContain("<table>");
  expect(md.render("A|B\n    C|D\n-|-\nx|y")).toContain("<table>");
  expect(md.render("-   item\n\n\t    A|B\n\t-|-\n\tx|y"))
    .toContain("<table>");
  const multiline = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  for (const source of [
    "A|B|\\\n\tC|D|\n-|-\nx|y",
    "\tcode|note|\\\n\tmore|rest|\n-|-\nx|y",
  ]) {
    const html = multiline.render(source);
    expect(html).toContain("<table>");
    expect(html).toContain("<th>");
    expect(html).not.toContain("\\");
  }
  expect(multiline.render("\tcode|note|\\\n\tmore|rest|\n-|-\nx|y"))
    .toContain("<pre><code>code\nmore\n</code></pre>");
});

test("markdown-it leaves pipe-bearing fenced and HTML openers with their host rules", () => {
  const md = new MarkdownIt({ html: true }).use(markdownItMultimdTable);
  const base = new MarkdownIt({ html: true });
  for (const source of [
    "```md|x\nA|B\n-|-\nx|y\n```",
    "~~~md|x\nA|B\n-|-\nx|y\n~~~",
    "> ```md|x\n> A|B\n> -|-\n> x|y\n> ```",
    "- item\n\n  ```md|x\n  A|B\n  -|-\n  x|y\n  ```",
    "<div>header|pipe\nA|B\n-|-\nx|y\n</div>",
  ]) {
    expect(md.render(source)).toBe(base.render(source));
    expect(md.parse(source, {}).some((token) => token.type === "table_open"))
      .toBe(false);
  }
  for (const source of ["# heading|B\n-|-\nx|y", "- list|B\n-|-\nx|y"])
    expect(normalize(md.render(source))).toEqual(normalize(renderReference(source)));
  expect(new MarkdownIt().use(markdownItMultimdTable)
    .render("<div>header|pipe\n-|-\nx|y")).toContain("<table>");
});

test("markdown-it silent recognition is side-effect free and respects endLine", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable, { multiline: true });
  const env = {};
  const source = "A|B\n-|-\n[r]: /target|plain|\\\n|plain|\n\nOutside [r]";
  const state = new md.block.State(source, md, env, []);
  state.parentType = "paragraph";
  const rule = md.block.ruler.getRules("")[0]!;
  expect(rule(state, 0, 1, true)).toBe(false);
  expect(rule(state, 0, state.lineMax, true)).toBe(true);
  expect(state.tokens).toEqual([]);
  expect(state.line).toBe(0);
  expect(state.level).toBe(0);
  expect(state.parentType).toBe("paragraph");
  expect(env).toEqual({});
  const limited = new md.block.State("A|B\n-|-\nx|y\nnext|row", md, {}, []);
  expect(rule(limited, 0, 3, false)).toBe(true);
  expect(limited.line).toBe(3);
  expect(limited.tokens.find((token) => token.type === "table_open")?.map).toEqual([0, 3]);
  expect(md.renderer.render(limited.tokens, md.options, {})).not.toContain("next");
  const lookahead = new md.block.State("A|B\nC|D\n-|-\nx|y", md, {}, []);
  expect(rule(lookahead, 0, 2, true)).toBe(false);
  expect(rule(lookahead, 0, lookahead.lineMax, true)).toBe(true);
});

test("markdown-it invalid pipe paragraphs avoid repeated suffix scans", () => {
  const md = new MarkdownIt().use(markdownItMultimdTable);
  let reads = 0;
  md.block.State = class extends md.block.State {
    override getLines(begin: number, end: number, indent: number, keepLastLF: boolean): string {
      reads += end - begin;
      return super.getLines(begin, end, indent, keepLastLF);
    }
  };
  const lines = 1000;
  const source = Array.from({ length: lines }, (_, index) => `row ${index}|literal`).join("\n");
  const html = md.render(source);
  expect(html).toBe(new MarkdownIt().render(source));
  expect(reads).toBeLessThanOrEqual(lines * 3);
});
