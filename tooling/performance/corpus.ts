import type { Options } from "../../src/core.js";

export interface Fixture {
  id: string;
  source: string;
  options: Options;
  /** 手工约定的分区行数；null 表示整段输入不是表格。 */
  rows: number[] | null;
}

const richRows: string[] = [];
for (let i = 0; i < 500; i++) {
  if (i && i % 125 === 0) richRows.push("");
  richRows.push(`| North ${i} | A | \`a|b\` | [x](/x) |`, `| ^^ | B | left\\|right | ${i} |`);
}

/** 固定语料独立于 parser/writer 生成；修改样本会改变报告中的语料指纹。 */
export const fixtures: Fixture[] = [
  ...[10, 1000, 5000].map((size): Fixture => ({
    id: `plain-${size}`,
    source: [
      "A|B|C|D",
      "-|-|-|-",
      ...Array.from({ length: size }, (_, i) => `row ${i}|value|code|${i}`),
    ].join("\n"),
    options: {},
    rows: [1, size],
  })),
  {
    id: "rich-1000",
    source: [
      "[**Sales**][sales]",
      "Region|Team|Sales||",
      "^^|^^|Q1|Q2",
      ":-|:-|-:|-:+",
      ...richRows,
    ].join("\n"),
    options: { rowspan: true },
    rows: [2, 250, 250, 250, 250],
  },
  {
    id: "multiline-500",
    source: [
      "A|B",
      "-|-",
      ...Array.from({ length: 500 }, (_, i) => `| step ${i} | - first |\\\n| next | - last |`),
    ].join("\n"),
    options: { multiline: true },
    rows: [1, 500],
  },
  {
    id: "escaped-1000",
    source: [
      "A|B|C|D",
      "-|-|-|-",
      ...Array.from({ length: 1000 }, () => "left\\|right|``a`|b``|😀|tail\\\\"),
    ].join("\n"),
    options: {},
    rows: [1, 1000],
  },
  {
    id: "wide-128",
    source: [
      Array(128).fill("H").join("|"),
      Array(128).fill("---").join("|"),
      ...Array.from({ length: 100 }, () => Array(128).fill("x").join("|")),
    ].join("\n"),
    options: {},
    rows: [1, 100],
  },
  {
    id: "unmatched-ticks",
    source:
      "A|B\n-|-\n" +
      Array.from({ length: 128 }, (_, i) => "`".repeat(i + 1) + "x").join("") +
      "|tail",
    options: {},
    rows: [1, 1],
  },
  {
    id: "invalid-5000",
    source: Array(5000).fill("candidate|without delimiter").join("\n"),
    options: {},
    rows: null,
  },
];
