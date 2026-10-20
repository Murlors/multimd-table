import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parseTable, type Options } from "../src/core.js";
import { stringifyTable } from "../src/writer.js";
import { syntaxCases, optionCases } from "./cases.js";
import { fixtures } from "../../../tooling/performance/corpus.js";
import golden from "../../../contracts/core-contracts.json" with { type: "json" };

/** 忽略对象属性插入顺序，数组与 UTF-16 字符串仍按原样参与摘要。 */
export const contractHash = (value: unknown) =>
  createHash("sha256")
    .update(
      JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      ),
    )
    .digest("hex");

const cases: { id: string; source: string; options: Options }[] = [...syntaxCases, ...fixtures].map(
  (c) => ({ id: "id" in c ? c.id : c.name, source: c.source, options: c.options ?? {} }),
);
for (let flags = 0; flags < 32; flags++) {
  const options = {
    multiline: !!(flags & 1),
    rowspan: !!(flags & 2),
    headerless: !!(flags & 4),
    multibody: !!(flags & 8),
    autolabel: !!(flags & 16),
  };
  for (const [i, c] of optionCases(options).entries())
    cases.push({ id: `options-${flags}-${i}`, source: c.source, options });
}
let seed = 0xc0ffee;
const random = (n: number) => {
  seed ^= seed << 13;
  seed ^= seed >>> 17;
  seed ^= seed << 5;
  return (seed >>> 0) % n;
};
const lines = [
  "A|B",
  "-|-",
  "|",
  "",
  "plain",
  "^^|^^",
  "x||",
  "| x | y |\\",
  "`a|b`|😀",
  "[İKΣ][Label]",
  "\u2003a|b\ufeff",
  "\\|x|\ud800",
];
for (let sample = 0; sample < 2000; sample++) {
  const options = {
    multiline: !!(sample & 1),
    rowspan: !!(sample & 2),
    headerless: !!(sample & 4),
    multibody: !!(sample & 8),
    autolabel: !!(sample & 16),
  };
  const source =
    (sample % 2 ? "A|B\n-|-\n" : "") +
    Array.from(
      { length: random(20) },
      () => lines[random(lines.length)]! + ["\n", "\r\n", "\r"][random(3)]!,
    ).join("");
  cases.push({ id: `seed-c0ffee-${sample}`, source, options });
}
// 覆盖批量 UTF-16 解码的 BOM、代理字符回退、分块边界和失败后的解码器状态。
for (const [index, value] of [
  "\ufeff" + "中文".repeat(64),
  "😀".repeat(128),
  "x".repeat(80) + "\ud800" + "y".repeat(80),
  "x".repeat(80) + "\udc00" + "y".repeat(80),
  "x".repeat(8191) + "😀" + "\ud800",
  "x".repeat(16383) + "😀" + "\udc00",
  "\ufeff" + "valid after fallback".repeat(8),
].entries())
  cases.push({ id: `writer-utf16-${index}`, source: `A|B\n-|-\n${value}|tail`, options: {} });

/** 固定输入和旧 TS 的冻结摘要共同守住语法契约；不自动更新预期结果。 */
export function contractVectors() {
  const vectors = cases.map((c) => {
    const model = parseTable(c.source, c.options);
    let written: string | undefined;
    if (model) {
      try {
        written = stringifyTable(model);
      } catch (error) {
        if (!(error instanceof RangeError)) throw error;
      }
    }
    return { ...c, model, ...(written === undefined ? {} : { written }) };
  });
  assert.equal(
    vectors.length,
    golden.groups.reduce((count, group) => count + group.count, 0),
  );
  let offset = 0;
  for (const expected of golden.groups) {
    const group = vectors.slice(offset, offset + expected.count);
    assert.equal(group[0]!.id, expected.first);
    assert.equal(group.at(-1)!.id, expected.last);
    assert.equal(
      contractHash(group),
      expected.sha256,
      `Contract changed: ${expected.first} … ${expected.last}`,
    );
    offset += expected.count;
  }
  const boundaries = [
    "```a\u2028b\nx\n```",
    "```a\u2029\nx\n```",
    "<a:x\u2028|y>",
    "<a:x\u00a0|y>",
    "<code>space \u2028\nnext</code>",
    "\u00a0# heading",
    "\u2028```a\nx\n```",
  ].map((value) => {
    const table = {
      columns: [{ align: null }, { align: null }],
      sections: [
        {
          kind: "body" as const,
          rows: [
            {
              cells: [
                {
                  column: 0,
                  value,
                  block: value.startsWith("```") || value.startsWith("\u2028```"),
                },
                { column: 1, value: "first\nlast", block: true },
              ],
            },
          ],
        },
      ],
    };
    try {
      return { written: stringifyTable(table) };
    } catch (error) {
      if (!(error instanceof RangeError)) throw error;
      return { error: "RangeError" };
    }
  });
  assert.equal(
    contractHash(boundaries),
    golden.writerBoundaries,
    "Unicode writer boundary contract changed",
  );
  return vectors;
}
