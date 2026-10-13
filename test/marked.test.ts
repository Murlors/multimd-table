import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Marked, type Token, type Tokens } from "marked";
import { parseFragment } from "parse5";
import markedMultimdTable, { type MarkedMultimdTableToken } from "../src/marked.js";
import { TableScanner, type Options } from "../src/core.js";
import { renderReference } from "./reference.js";

function normalizeHTML(html: string): unknown {
  function walk(node: any, pre = false): any {
    if (node.nodeName === "#text")
      return pre ? node.value : node.value.trim() ? node.value.replace(/\s+/g, " ").trim() : null;
    return {
      tag: node.tagName || node.nodeName,
      attrs: [...(node.attrs || [])].sort((a: any, b: any) => a.name.localeCompare(b.name)),
      children: (node.childNodes || [])
        .map((child: any) => walk(child, pre || node.tagName === "pre"))
        .filter((value: any) => value !== null),
    };
  }
  return walk(parseFragment(html));
}

const render = (source: string, options: Options = {}) =>
  new Marked(markedMultimdTable(options)).parse(source, { async: false });

for (const file of ["standard", "options", "unspecified"]) {
  const options: Options = file === "options"
    ? { multiline: true, rowspan: true, headerless: true, multibody: false, autolabel: false }
    : {};
  const input = readFileSync(new URL(`./fixtures/${file}.txt`, import.meta.url), "utf8");
  const parts = input.split(/^\.\r?$/m);
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const title = parts[i]!.trim().split("\n").at(-1)!;
    const source = parts[i + 1]!.replace(/^\n/, "");
    const expected = parts[i + 2]!.trim();
    test(`Marked ${file}: ${title}`, () => {
      expect(normalizeHTML(render(source, options))).toEqual(normalizeHTML(expected));
    });
  }
}

const optionSamples = [
  "[Sales]\n| Region | 2026 ||\n| Name | Qty | Revenue |\n|:---|---:+|===:|\n| East | 3 | 90 |\n| ^^ | 5 | 150 |\n\n| South | 8 ||\n[After]",
  "|--|--|\n| A ||\n| ^^ ||\n[Caption]",
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
  test(`Marked all option combinations ${flags}`, () => {
    for (const source of optionSamples)
      expect(normalizeHTML(render(source, options))).toEqual(
        normalizeHTML(renderReference(source, options)),
      );
  });
}

test("Marked exposes merged cells as a custom block token with native children", () => {
  const marked = new Marked(markedMultimdTable({ rowspan: true }));
  const tokens = marked.lexer("[**Caption**]\nA|B\n-|-\n[link](/safe)||\n^^||");
  const table = tokens[0] as MarkedMultimdTableToken;
  expect(table.type).toBe("multimdTable");
  expect(table.model.sections[1]!.rows[0]!.cells[0]).toMatchObject({ colspan: 2, rowspan: 2 });
  expect(table.cellTokens[2]![0]!.type).toBe("link");
  expect(table.captionTokens[0]!.type).toBe("strong");
  const visited: string[] = [];
  marked.walkTokens(tokens, (token) => { visited.push(token.type); });
  expect(visited.filter((type) => type === "link")).toHaveLength(1);
  expect(visited.filter((type) => type === "strong")).toHaveLength(1);
});

test("Marked cells and captions share custom inline tokenizers and renderers", () => {
  const marked = new Marked(markedMultimdTable({ multiline: true }), {
    extensions: [{
      name: "mention",
      level: "inline",
      start(source) { return source.indexOf("@"); },
      tokenizer(source) {
        const match = /^@([a-z]+)/.exec(source);
        if (match) return { type: "mention", raw: match[0], text: match[1] };
      },
      renderer(token) { return `<mark>${token.text}</mark>`; },
    }],
    renderer: {
      strong({ tokens }) { return `<b>${this.parser.parseInline(tokens)}</b>`; },
      paragraph({ tokens }) { return `<p class="host">${this.parser.parseInline(tokens)}</p>\n`; },
    },
  });
  const html = marked.parse("[@caption]\nA|B\n-|-\n@inline|**strong**\n- @block|one|\\\n- two|next|", { async: false });
  expect(html).toContain("<caption id=\"caption\"><mark>caption</mark></caption>");
  expect(html).toContain("<td><mark>inline</mark></td>");
  expect(html).toContain("<td><b>strong</b></td>");
  expect(html).toContain("<li><mark>block</mark></li>");
  expect(html).toContain('<p class="host">one\nnext</p>');
});

test("Marked multiline cells retain custom block tokens and their native descendants", async () => {
  let visited = 0;
  const marked = new Marked(markedMultimdTable({ multiline: true }), {
    extensions: [{
      name: "notice",
      level: "block",
      tokenizer(source) {
        const match = /^!note ([^\n]+)(?:\n|$)/.exec(source);
        if (match) return {
          type: "notice",
          raw: match[0],
          tokens: this.lexer.inline(match[1]!),
        };
      },
      renderer(token) { return `<aside>${this.parser.parseInline(token.tokens!)}</aside>\n`; },
    }],
    async: true,
    async walkTokens(token) {
      if (token.type !== "link") return;
      await Promise.resolve();
      (token as Tokens.Link).href = "/walked";
      visited++;
    },
  });
  const html = await marked.parse("A|B\n-|-\n!note [ref][r]|one|\\\nfollowing|two|\n\n[r]: /safe");
  expect(visited).toBe(1);
  expect(html).toContain('<aside><a href="/walked">ref</a></aside>');
  expect(html).toContain("<p>following</p>");
});

for (const async of [false, true]) {
  test(`Marked ${async ? "async" : "sync"} walkTokens visits every cell and caption once`, async () => {
    const links: string[] = [];
    const mutate = (token: Token) => {
      if (token.type !== "link") return;
      const link = token as Tokens.Link;
      links.push(link.href);
      link.href += "/walked";
    };
    const marked = new Marked(markedMultimdTable({ multiline: true }), {
      async,
      walkTokens: async
        ? async (token) => { await Promise.resolve(); mutate(token); }
        : mutate,
    });
    const html = await marked.parse("[[caption](/caption)]\n[head](/head)|B\n-|-\n[inline](/inline)|[block](/block)|\\\nnext|[tail](/tail)|");
    expect(links.sort()).toEqual(["/block", "/caption", "/head", "/inline", "/tail"]);
    for (const href of links) expect(html).toContain(`href="${href}/walked"`);
  });
}

for (const before of [false, true]) {
  test(`Marked document definitions ${before ? "precede" : "follow"} inline and block cells`, () => {
    const table = "[[caption][r]]\nA|B\n-|-\n[r]|first\n- [r]|[r]|\\\n- [r]|next|";
    const definition = "[r]: /safe";
    const source = before ? definition + "\n\n" + table : table + "\n\n" + definition;
    expect(render(source, { multiline: true }).match(/href="\/safe"/g)).toHaveLength(5);
  });
}

test("Marked block-cell definitions resolve in earlier tables, other cells and outside text", () => {
  const source = "A|B\n-|-\n[r]|first\n\nbetween\n\nA|B\n-|-\n> [r]: /safe|[r]|\\\n> text|two|\n\nOutside [r]";
  expect(render(source, { multiline: true }).match(/href="\/safe"/g)).toHaveLength(3);
});

for (const outerFirst of [false, true]) {
  test(`Marked duplicate definitions retain source precedence, outer ${outerFirst ? "first" : "last"}`, () => {
    const table = "A|B\n-|-\n[r]: /cell|[r]|\\\ntext|two|";
    const outer = "[r]: /outer";
    const source = (outerFirst ? outer + "\n\n" + table : table + "\n\n" + outer) + "\n\nOutside [r]";
    const target = outerFirst ? "outer" : "cell";
    expect(render(source, { multiline: true }).match(new RegExp(`href="/${target}"`, "g"))).toHaveLength(2);
  });
}

test("Marked instance reuse keeps references and options local to each parse", () => {
  const options = { rowspan: true };
  const marked = new Marked().use(markedMultimdTable(options));
  options.rowspan = false;
  const table = "A|B\n-|-\n[r]|x\n^^|y";
  expect(marked.parse(table + "\n\n[r]: /first", { async: false })).toContain('href="/first"');
  const next = marked.parse(table, { async: false });
  expect(next).toContain('rowspan="2">[r]</td>');
  expect(next).toContain('rowspan="2"');
  expect(next).not.toContain("<a ");
  expect(marked.parse(table + "\n\n[r]: /second", { async: false })).toContain('href="/second"');
});

test("Marked restores list state after block-cell lexing and preserves following native blocks", () => {
  const source = "- A|B\n  -|-\n  - one|first|\\\n  - two|second|\n\n  after\n\n# Heading\n\n> quote\n\n- next";
  const html = render(source, { multiline: true });
  expect(html).toContain("<li>one</li>");
  expect(html).toContain("<li>two</li>");
  expect(html).toContain("<p>after</p>");
  expect(html).toContain("<h1>Heading</h1>");
  expect(html).toContain("<blockquote>");
  expect(html).toContain("<li>next</li>");
});

for (const eol of ["\n", "\r\n", "\r"]) {
  test(`Marked immediate paragraphs and nested table starts with ${JSON.stringify(eol)}`, () => {
    const source = ["before", "[Caption]", "A|B", "C|D", "-|-", "x|y", "", "after", "", "> A|B", "> -|-", "> x|y"].join(eol);
    const html = render(source);
    expect(html.startsWith("<p>before</p>\n<table>")).toBe(true);
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html.match(/<th>/g)).toHaveLength(6);
    expect(html).toContain("<p>after</p>");
  });
}

test("Marked committed tables retain literal block markers in cells after body gaps", () => {
  const source = "A|B\n-|-\nx|y\n\n- literal|> literal\n# literal|z";
  const html = render(source);
  expect(html.match(/<tbody>/g)).toHaveLength(2);
  expect(html).toContain("<td>- literal</td>");
  expect(html).toContain("<td>&gt; literal</td>");
  expect(html).toContain("<td># literal</td>");
});

test("Marked keeps native fences, indented code, block boundaries and invalid pipes", () => {
  for (const source of [
    "```md\nA|B\n-|-\nx|y\n```",
    "~~~md|example\nA|B\n-|-\nx|y\n~~~",
    "    A|B\n    -|-\n    x|y",
    "text | pipe\n- list\n",
    "text | pipe\n> quote\n",
    "a|b\nc|d\n# heading\n",
    "a|b\n```md\nc|d\n-|-\nx|y\n```",
    "escaped \\| text\ncode `|` text\nordinary paragraph",
  ]) expect(render(source)).toBe(new Marked().parse(source, { async: false }));
});

for (const spaces of [0, 1, 2, 3]) {
  const indent = " ".repeat(spaces) + "\t";
  test(`Marked ${spaces} spaces plus Tab preserve native code and paragraph starts`, () => {
    const table = indent + "A|B\n-|-\nx|y";
    for (const source of [table, "before\n" + table, "before\n\n" + table])
      for (const options of [{}, { multiline: true }])
        expect(render(source, options)).toBe(new Marked().parse(source, { async: false }));
    // 旧版 oracle 在 0/1 空格前缀与 Marked 同意该代码边界；2/3 空格是旧宿主差异。
    if (spaces < 2) expect(normalizeHTML(render(table))).toEqual(normalizeHTML(renderReference(table)));
  });

  test(`Marked ${spaces} spaces plus Tab remain code relative to quote containers`, () => {
    const quote = `> before\n>\n> ${indent}A|B\n> -|-\n> x|y`;
    const nestedQuote = `- > before\n  >\n  > ${indent}A|B\n  > -|-\n  > x|y`;
    for (const source of [quote, nestedQuote])
      for (const options of [{}, { multiline: true }]) {
        expect(render(source, options)).toBe(new Marked().parse(source, { async: false }));
        expect(render(source, options)).not.toContain("<table>");
        expect(render(source, options)).toContain("<pre><code>");
      }
  });

  test(`Marked committed body keeps ${spaces} spaces plus Tab in legal pipe rows`, () => {
    for (const gap of ["", "\n"]) {
      const html = render(`A|B\n-|-\nx|y\n${gap}${indent}cell|value`);
      expect(html.match(/<table>/g)).toHaveLength(1);
      expect(html).toContain("<td>cell</td>");
      expect(html).toContain("<td>value</td>");
    }
  });
}

test("Marked list deindentation keeps Tabs that become a valid shallow header", () => {
  for (const source of [
    "- \tA|B\n  -|-\n  x|y",
    "- item\n\n  \tA|B\n  -|-\n  x|y",
    "- item\n\n   \tA|B\n  -|-\n  x|y",
  ]) {
    expect(normalizeHTML(render(source))).toEqual(
      normalizeHTML(new Marked().parse(source, { async: false })),
    );
    expect(render(source)).toContain("<table>");
  }
});

test("Marked pure space header indentation retains MultiMarkdown compatibility", () => {
  for (const source of [
    "    A|B\n-|-\nx|y",
    ">     A|B\n> -|-\n> x|y",
    "- item\n\n      A|B\n  -|-\n  x|y",
  ]) {
    expect(normalizeHTML(render(source))).toEqual(normalizeHTML(renderReference(source)));
    expect(render(source)).toContain("<table>");
  }
});

test("Marked multiline headers retain Tab-indented block-cell continuation", () => {
  for (const table of [
    "    code|description|\\\n\tprint()|text|\n-|-\nx|y",
    "\tcode|description|\\\n\tprint()|text|\n-|-\nx|y",
    "\tcode|description|\\\nprint()|text|\n-|-\nx|y",
  ]) {
    for (const source of [table, "> " + table.replaceAll("\n", "\n> ")]) {
      const html = render(source, { multiline: true });
      expect(normalizeHTML(html)).toEqual(normalizeHTML(renderReference(source, { multiline: true })));
      expect(html).toContain("<thead>");
      expect(html).toContain("<pre><code>code");
    }
    // Marked 的 start 扩展可中断段落；表格本身仍与旧版 oracle 一致。
    expect(normalizeHTML(render("before\n" + table, { multiline: true }))).toEqual(
      normalizeHTML("<p>before</p>\n" + renderReference(table, { multiline: true })),
    );
  }
});

test("Marked multiline continuation does not release native fence or HTML boundaries", () => {
  for (const source of [
    "header|text|\\\n```md|other|\n-|-\nx|y\n```",
    "header|text|\\\n<div>|other|\n-|-\nx|y",
  ]) expect(render(source, { multiline: true })).toBe(new Marked().parse(source, { async: false }));
});

test("Marked long invalid pipe paragraphs remain one native paragraph", () => {
  const source = Array.from({ length: 2500 }, (_, i) => `row ${i}|value`).join("\n");
  const marked = new Marked(markedMultimdTable());
  const tokens = marked.lexer(source);
  expect(tokens).toHaveLength(1);
  expect(tokens[0]!.type).toBe("paragraph");
  expect(marked.parser(tokens)).toBe(new Marked().parse(source, { async: false }));
});

test("Marked invalid list pipe runs preserve fallback and a later table", () => {
  const invalid = Array.from({ length: 300 }, (_, i) => `  row ${i}|value`).join("\n");
  const source = "- intro\n" + invalid + "\n\n  A|B\n  -|-\n  x|y\n\nOutside";
  const html = render(source);
  expect(html.match(/<table>/g)).toHaveLength(1);
  expect(html).toContain("row 0|value");
  expect(html).toContain("row 299|value");
  expect(html).toContain("</ul>\n<p>Outside</p>");

  const countScan = (source: string, options: Options = {}) => {
    const push = TableScanner.prototype.push;
    let calls = 0;
    TableScanner.prototype.push = function (value, offset) {
      calls++;
      return push.call(this, value, offset);
    };
    try {
      return { html: render(source, options), calls };
    } finally {
      TableScanner.prototype.push = push;
    }
  };
  for (const tail of [
    "",
    "\n  \t\n  A|B\n  -|-\n  x|y\n\nOutside",
    "\n  \n  A|B\n  -|-\n  [r]: /safe|[r]|\\\n  tail|next|\n\nOutside [r]",
  ]) {
    let previousCalls: number | undefined;
    for (const size of [30, 60, 120]) {
      const invalid = Array.from({ length: size }, (_, i) => `  row ${i}|value`).join("\n");
      const result = countScan("- intro\n" + invalid + tail, { multiline: true });
      expect(result.html).toContain(`row ${size - 1}|value`);
      expect(result.html.match(/<table>/g) || []).toHaveLength(tail ? 1 : 0);
      if (tail.includes("/safe")) expect(result.html.match(/href="\/safe"/g)).toHaveLength(2);
      // 检查扫描随源行数近线性增长，不锁定固定调用数或测量宿主执行时间。
      if (previousCalls !== undefined) expect(result.calls).toBeLessThanOrEqual(previousCalls * 2.5);
      previousCalls = result.calls;
    }
  }
});

test("Marked lazy container continuations retain native GFM ownership", () => {
  // Marked 18 在非空行处继续外层容器；适配器保留宿主行为和 core 的行语义。
  for (const source of [
    "> A|B\n> -|-\n> x|y\noutside|row",
    "- A|B\n  -|-\n  x|y\noutside|row",
  ]) expect(normalizeHTML(render(source))).toEqual(
    normalizeHTML(new Marked().parse(source, { async: false })),
  );
});

test("Marked failure hints do not cross quote continuation chunks or block cells", () => {
  const source = "> a|b\n> c|d\nunquoted\n> A|B\n> -|-\n> x|y\n\nA|B\n-|-\na|b|\\\nc|d|\n\n\nC|D\n-|-\nx|y";
  const html = render(source, { multiline: true });
  expect(html.match(/<table>/g)).toHaveLength(3);
  expect(html).toContain("a|b\nc|d");
  expect(html).toContain("<td><p>a\nc</p>");
});

for (const length of [22, 23, 24]) {
  test(`Marked quote frames isolate failed headers from equal-sized sources (${length})`, () => {
    const source = `> a|b\n> ${"x".repeat(length)}|q\n[caption]\n> A|B\n> C|D\n> -|-\n> x|y`;
    const html = render(source);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain('<caption id="caption">caption</caption>');
    for (const value of ["A", "B", "C", "D"]) expect(html).toContain(`<th>${value}</th>`);
    expect(html).toContain(`${"x".repeat(length)}|q`);
  });

  test(`Marked nested quote frames isolate failed headers (${length})`, () => {
    const source = `- > a|b\n  > ${"x".repeat(length)}|q\n  [caption]\n  > A|B\n  > C|D\n  > -|-\n  > x|y`;
    const html = render(source);
    expect(html.match(/<table>/g)).toHaveLength(1);
    expect(html).toContain('<caption id="caption">caption</caption>');
    expect(html).toContain("<th>A</th>");
    expect(html).toContain("<th>C</th>");
    expect(html).toContain(`${"x".repeat(length)}|q`);
  });
}

test("Marked frame wrapping retains host blockTokens overrides, this, arguments and results", () => {
  const marked = new Marked(markedMultimdTable({ multiline: true }));
  const lexer = new marked.Lexer(marked.defaults);
  const blockTokens = lexer.blockTokens;
  const calls: { source: string; clipped?: boolean }[] = [];
  lexer.blockTokens = (function (this: typeof lexer, ...args: Parameters<typeof blockTokens>) {
    expect(this).toBe(lexer);
    calls.push({ source: args[0], clipped: args[2] });
    const source = args[0].replace("HOST_VALUE", "host value");
    const output = blockTokens.call(this, source, args[1], args[2]);
    if (args[1]) expect(output).toBe(args[1]);
    return output;
  }) as typeof blockTokens;
  const tokens = lexer.lex("> A|B\n> -|-\n> HOST_VALUE|first|\\\n> following|second|");
  const html = marked.parser(tokens);
  expect(html).toContain("<p>host value\nfollowing</p>");
  expect(calls.some(({ clipped }) => clipped === true)).toBe(true);
  expect(calls.some(({ source }) => source === "host value\nfollowing")).toBe(true);
});

test("Marked nested frame exceptions restore the parent and allow subsequent parsing", () => {
  let failures = 0;
  const marked = new Marked(markedMultimdTable({ multiline: true }), {
    extensions: [{
      name: "recover",
      level: "block",
      tokenizer(source) {
        if (!source.startsWith("RECOVER\n")) return;
        try {
          this.lexer.blockTokens("FAIL");
        } catch (error) {
          expect((error as Error).message).toBe("host failure");
          failures++;
        }
        const tokens = this.lexer.blockTokens("[caption]\nA|B\nC|D\n-|-\n[r]|y", [], true);
        return { type: "recover", raw: "RECOVER\n", tokens };
      },
      renderer(token) { return this.parser.parse(token.tokens!); },
    }],
  });
  const lexer = new marked.Lexer(marked.defaults);
  const blockTokens = lexer.blockTokens;
  lexer.blockTokens = (function (this: typeof lexer, ...args: Parameters<typeof blockTokens>) {
    if (args[0] === "FAIL") throw new Error("host failure");
    return Reflect.apply(blockTokens, this, args);
  }) as typeof blockTokens;
  const source = "A|B\n-|-\nRECOVER|one|\\\nfollowing|two|\n\nbetween\n\nC|D\n-|-\n[r]|plain\n\n[r]: /safe";
  const html = marked.parser(lexer.lex(source));
  expect(failures).toBe(1);
  expect(html.match(/<table>/g)).toHaveLength(3);
  expect(html).toContain('<caption id="caption">caption</caption>');
  expect(html.match(/href="\/safe"/g)).toHaveLength(2);
  const previousCount = lexer.tokens.length;
  const next = marked.parser(lexer.lex("A|B\n-|-\n[r]|next").slice(previousCount));
  // Lexer 重用保留宿主的 links；适配器不得改变宿主手动重用 lexer 的引用作用域。
  expect(next).toContain('href="/safe"');
  expect(next.match(/<table>/g)).toHaveLength(1);
});

test("Marked reuse with different document sizes and multiple tables preserves every definition", () => {
  const marked = new Marked(markedMultimdTable({ multiline: true }));
  for (const size of [32, 4, 80, 1]) {
    const invalid = Array.from({ length: size }, (_, i) => `row ${i}|invalid`).join("\n");
    const source = invalid + "\n\nA|B\n-|-\n[r]|one\n\nbetween\n\nA|B\n-|-\n[r]: /safe|[r]|\\\ntail|two|";
    const html = marked.parse(source, { async: false });
    expect(html.match(/<table>/g)).toHaveLength(2);
    expect(html.match(/href="\/safe"/g)).toHaveLength(2);
    expect(html).toContain(`row ${size - 1}|invalid`);
    expect(marked.parse("A|B\n-|-\n[r]|plain", { async: false })).not.toContain("<a ");
  }
});
