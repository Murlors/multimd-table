import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import { parseFragment } from "parse5";
import remarkMultimdTable, { type RemarkOptions } from "../src/remark.js";
import { type Options } from "../src/core.js";

export function normalize(html: string): unknown {
  function walk(node: any, pre = false): any {
    if (node.nodeName === "#text")
      return pre ? node.value : node.value.trim() ? node.value.replace(/\s+/g, " ").trim() : null;
    return {
      tag: node.tagName || node.nodeName,
      attrs: [...(node.attrs || [])].sort((a: any, b: any) => a.name.localeCompare(b.name)),
      children: (node.childNodes || [])
        .map((child: any) => walk(child, pre || node.tagName === "pre"))
        .filter((x: any) => x !== null),
    };
  }
  return walk(parseFragment(html));
}
export function render(source: string, options: RemarkOptions = {}) {
  return String(
    unified()
      .use(remarkParse)
      .use(remarkMultimdTable, options)
      .use(remarkRehype)
      .use(rehypeStringify)
      .processSync(source),
  );
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
  const input = readFileSync(new URL(`./fixtures/${file}.txt`, import.meta.url), "utf8");
  const parts = input.split(/^\.\r?$/m);
  for (let i = 0; i + 2 < parts.length; i += 3) {
    const title = parts[i]!.trim().split("\n").at(-1)!;
    const source = parts[i + 1]!.replace(/^\n/, "");
    const html = parts[i + 2]!.trim();
    test(`${file}: ${title}`, () => {
      expect(
        normalize(
          render(source, {
            ...options,
          }),
        ),
      ).toEqual(normalize(html));
    });
  }
}
