import { expect, test } from "bun:test";
import { Marked } from "marked";
import { parseFragment, serialize } from "parse5";
import { parseTable, type Table } from "../src/core.js";
import { stringifyTable, type WriteTable, type WriteCell, type WriteSection } from "../src/writer.js";

const options = { rowspan: true, multiline: true, headerless: true, multibody: true };
const markdown = new Marked();

/** 按结构和宿主解释后的内容比较，源文空白及转义形式不属于写出契约。 */
function semantic(table: WriteTable | Table) {
  const html = (source: string) => serialize(parseFragment(source));
  return {
    columns: table.columns.map((column) => ({ align: column.align, wrap: !!column.wrap })),
    caption: table.caption ? {
      side: table.caption.side,
      id: table.caption.id,
      html: html(String(markdown.parseInline(table.caption.value))),
    } : null,
    sections: table.sections.map((section) => ({
      kind: section.kind,
      rows: section.rows.map((row) => row.cells.map((cell) => ({
        column: cell.column,
        colspan: cell.colspan ?? 1,
        rowspan: cell.rowspan ?? 1,
        // Inline paragraphs may become block paragraphs when their sibling needs continuation.
        html: html(cell.block || /[\r\n]/.test(cell.value)
          ? String(markdown.parse(cell.value, { async: false })).trim()
          : cell.value.trim() ? `<p>${markdown.parseInline(cell.value)}</p>` : ""),
      })).sort((a, b) => a.column - b.column)),
    })),
  };
}

function roundTrip(table: WriteTable) {
  const source = stringifyTable(table);
  const parsed = parseTable(source, { ...options, autolabel: table.caption?.id !== null });
  expect(parsed).not.toBeNull();
  expect(semantic(parsed!)).toEqual(semantic(table));
  expect(parsed!.range.end).toBe(source.length);
  return source;
}

function basic(value = "value"): WriteTable {
  return {
    columns: [{ align: null }, { align: null }],
    sections: [{ kind: "body", rows: [{ cells: [{ column: 0, value }, { column: 1, value: "" }] }] }],
  };
}

test("combined spans use one upward marker and genuine empty cells stay separate", () => {
  const table: WriteTable = {
    columns: [{ align: "left", wrap: true }, { align: "center" }, { align: "right" }],
    sections: [
      { kind: "head", rows: [
        { cells: [{ column: 0, colspan: 3, value: "Overview" }] },
        { cells: [{ column: 0, value: "A" }, { column: 1, value: "B" }, { column: 2, value: "C" }] },
      ] },
      { kind: "body", rows: [
        { cells: [{ column: 0, colspan: 2, rowspan: 3, value: "merged" }, { column: 2, value: "" }] },
        { cells: [{ column: 2, value: "next" }] },
        { cells: [{ column: 2, value: "last" }] },
      ] },
      { kind: "body", rows: [{ cells: [{ column: 0, value: "" }, { column: 1, colspan: 2, value: "new body" }] }] },
    ],
    caption: { side: "bottom", value: "**Totals**", id: "totals" },
  };
  const snapshot = structuredClone(table);
  const source = roundTrip(table);
  expect(source).toContain("| ^^ || next |");
  expect(source).toContain("| merged ||  |");
  expect(table).toEqual(snapshot);
});

test("literal markers, pipes, slash parity and inline code retain Markdown semantics", () => {
  for (const value of [
    "^^", "---", ":===:+", "a|b", "a\\|b", "a\\\\|b", "a\\\\\\|b", "tail\\",
    "`a|b`", "``a|b``", "`` a|b ``", "``a`b``", "`unclosed", "``unclosed",
    "\\`literal|pipe", "\\\\`code|pipe`", "[a|b](/path)", "[link](/path|part)", "**a|b**", "😀|🦊",
    "`a\nb|c`", "alpha\nbeta", "alpha  \nbeta",
    '<span title="a|b">**text**</span>', '<span title="a>b|c">text</span>', "<code>literal`tick|pipe</code>",
  ]) roundTrip(basic(value));
});

test("multiple block cells preserve paragraphs, lists, fences and indentation", () => {
  const table = basic("- first\n- second\n\nparagraph\n\n```ts\nconst n = 1;\n```\n\n    indented");
  const first = table.sections[0]!.rows[0]!.cells[0]!;
  first.block = true;
  roundTrip(table);
  for (const value of ["one paragraph", "---", "^^", "\n", "a  \nb", "`a|b`\nnext", "# heading\n\ntext"]) {
    const block = basic(value);
    block.sections[0]!.rows[0]!.cells[0]!.block = true;
    roundTrip(block);
    expect(parseTable(stringifyTable(block), options)!.sections[0]!.rows[0]!.cells[0]!.block).toBe(true);
  }
});

test("inline siblings retain literal block markers in a continued row", () => {
  for (const value of ["---", "# heading", "> quote", "- bullet", "+ bullet", "* bullet", "1. item", "2) item", "___", "***", "**bold**"]) {
    const table = basic(value);
    table.sections[0]!.rows[0]!.cells[1]!.value = "first\nsecond";
    table.sections[0]!.rows[0]!.cells[1]!.block = true;
    roundTrip(table);
  }
});

test("inline siblings preserve leading spaces and tabs without becoming indented code", () => {
  for (const value of ["    paragraph", "\tparagraph", " \tparagraph", "   paragraph", "    # heading", "\t# heading", "\t- bullet"]) {
    const table = basic(value);
    table.sections[0]!.rows[0]!.cells[1]!.value = "first\nsecond";
    table.sections[0]!.rows[0]!.cells[1]!.block = true;
    const source = roundTrip(table);
    const first = parseTable(source, options)!.sections[0]!.rows[0]!.cells[0]!;
    expect(markdown.parse(first.value, { async: false })).not.toContain("<pre>");
  }
});

test("caption sides and representable normalized IDs survive", () => {
  for (const side of ["top", "bottom"] as const) {
    for (const caption of [
      { value: "caption with **bold** and [link](/path)", id: "explicit_id" },
      { value: "a [reference][label]", id: "reference" },
      { value: "中文标题", id: "" },
      { value: "...", id: "" },
      { value: "English empty ID", id: "" },
      { value: "unlabeled", id: null },
    ]) roundTrip({ ...basic(), caption: { ...caption, side } });
  }
  const parsed = parseTable(stringifyTable({ ...basic(), caption: { value: "Hello World", side: "top" } }), options)!;
  expect(parsed.caption!.id).toBe("helloworld");
  for (const caption of [
    { value: "caption", side: "top", id: "Mixed-Case" },
    { value: "caption\nnext", side: "top" },
    { value: "first][looks_like_id", side: "top" },
  ]) expect(() => stringifyTable({ ...basic(), caption: caption as any })).toThrow(RangeError);
});

test("seeded multi-section tilings retain spans and Markdown semantics (seed 0x51a7)", () => {
  let state = 0x51a7;
  const random = (limit: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % limit;
  };
  for (let sample = 0; sample < 200; sample++) {
    const width = random(8) + 1;
    const values = ["", "plain", "😀", "**bold**", "left|right", "`a|b`", "^^", "[link](/target)", "first\nsecond", "- one\n- two"];
    const sections: WriteSection[] = [];
    for (const kind of ["head", "body", "body"] as const) {
      const height = random(8) + 1;
      const occupied = Array.from({ length: height }, () => Array<boolean>(width).fill(false));
      const rows = Array.from({ length: height }, () => ({ cells: [] as WriteCell[] }));
      for (let r = 0; r < height; r++) {
        for (let c = 0; c < width; c++) {
          if (occupied[r]![c]) continue;
          let available = 1;
          while (c + available < width && !occupied[r]![c + available]) available++;
          const colspan = random(available) + 1;
          let down = 1;
          while (r + down < height && occupied[r + down]!.slice(c, c + colspan).every((slot) => !slot)) down++;
          const rowspan = random(down) + 1;
          for (let dr = 0; dr < rowspan; dr++)
            for (let dc = 0; dc < colspan; dc++) occupied[r + dr]![c + dc] = true;
          const value = values[random(values.length)]!;
          rows[r]!.cells.push({ column: c, colspan, rowspan, value, block: value.includes("\n") });
        }
      }
      sections.push({ kind, rows });
    }
    try {
      roundTrip({
        columns: Array.from({ length: width }, () => ({ align: ([null, "left", "center", "right"] as const)[random(4)]!, wrap: !!random(2) })),
        sections,
        caption: { value: "**Summary**", id: "summary", side: sample % 2 ? "top" : "bottom" },
      });
    } catch (error) {
      throw new Error(`seed=0x51a7 sample=${sample} width=${width}`, { cause: error });
    }
  }
});

test("invalid grids and nonrepresentable code fail explicitly", () => {
  const cases = [
    { columns: [], sections: [] },
    { ...basic(), sections: [] },
    { ...basic(), sections: [{ kind: "body", rows: [] }] },
    { ...basic(), sections: [{ kind: "body", rows: [{ cells: [{ column: 0, value: "gap" }] }] }] },
    { ...basic(), sections: [{ kind: "head", rows: basic().sections[0]!.rows }, { kind: "head", rows: basic().sections[0]!.rows }] },
  ];
  for (const table of cases) expect(() => stringifyTable(table as WriteTable)).toThrow(RangeError);
  for (const extra of [{ column: -1 }, { column: 0.5 }, { colspan: 0 }, { rowspan: 2 }, { colspan: 3 }, { colspan: 2 }, { rowspan: NaN }]) {
    const table = basic();
    Object.assign(table.sections[0]!.rows[0]!.cells[0]!, extra);
    expect(() => stringifyTable(table)).toThrow(RangeError);
  }
  for (const value of ["```\na|b\n```", "    code|pipe", "```\ncode  \n```", "``a`b|c``", "<pre>code  \nnext</pre>", "<https://example.com/a|b>"]) {
    const table = basic(value);
    table.sections[0]!.rows[0]!.cells[0]!.block = true;
    expect(() => stringifyTable(table)).toThrow(RangeError);
  }
});
