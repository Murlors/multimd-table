import assert from "node:assert/strict";
import { afterEach, test } from "bun:test";
import { runtime } from "../src/internal/backend.js";
import { cellBounds, parseTable, TableScanner, type Range, type Table } from "../src/core.js";
import { fixtures } from "../tooling/performance/corpus.js";
afterEach(() => runtime.disposeScanners());

/** 慢速参考扫描：逐字符识别转义和匹配反引号，不共享生产扫描器的游标及缓存。 */
function referenceBounds(source: string): number[] {
  const pipes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\\") { i++; continue; }
    if (source[i] === "`") {
      let end = i;
      while (source[end] === "`") end++;
      const size = end - i;
      let closed = false;
      for (let j = end; j < source.length; j++) {
        if (source[j] !== "`") continue;
        let next = j;
        while (source[next] === "`") next++;
        if (next - j === size) { i = next - 1; closed = true; break; }
        j = next - 1;
      }
      if (!closed) i = end - 1;
    } else if (source[i] === "|") pipes.push(i);
  }
  if (!pipes.length) return [];
  const end = source.trimEnd().length;
  return [...(pipes[0] === 0 ? [] : [-1]), ...pipes, ...(pipes.at(-1) === end - 1 ? [] : [end])];
}

function random(seed: number) {
  return (limit: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % limit;
  };
}

/** 验证源文坐标，而非只比较两个共享实现产生的模型。 */
function sourceContract(source: string, table: Table) {
  const range = ({ start, end }: Range) => {
    assert.ok(Number.isInteger(start) && Number.isInteger(end));
    assert.ok(0 <= start && start <= end && end <= source.length);
  };
  const inside = (child: Range, parent: Range) => {
    range(child);
    assert.ok(parent.start <= child.start && child.end <= parent.end);
  };
  range(table.range);
  if (table.caption) {
    inside(table.caption.range, table.range);
    inside(table.caption.contentRange, table.caption.range);
    assert.equal(source.slice(table.caption.contentRange.start, table.caption.contentRange.end), table.caption.value);
  }
  for (const section of table.sections) {
    inside(section.range, table.range);
    for (const row of section.rows) {
      inside(row.range, section.range);
      for (const cell of row.cells) {
        inside(cell.range, row.range);
        cell.segments.forEach(segment => inside(segment, cell.range));
        assert.equal(cell.segments.map(({ start, end }) => source.slice(start, end)).join("\n"), cell.value);
      }
    }
  }
}

test("baseline: exhaustive pipe, slash and tick combinations through length 8", () => {
  const visit = (source: string, remaining: number) => {
    assert.deepEqual(cellBounds(source), referenceBounds(source), JSON.stringify(source));
    if (remaining) for (const char of ["a", "|", "`", "\\"]) visit(source + char, remaining - 1);
  };
  visit("", 8);
});

test("baseline: seeded Unicode, whitespace and long delimiter runs (seed 0x51a7)", () => {
  const next = random(0x51a7);
  const parts = ["a", "|", "`", "\\", " ", "\t", "😀", "\ud800", "\u00a0", "`".repeat(17), "\\".repeat(16)];
  for (let sample = 0; sample < 3000; sample++) {
    const source = Array.from({ length: next(64) }, () => parts[next(parts.length)]!).join("");
    assert.deepEqual(cellBounds(source), referenceBounds(source), `seed=0x51a7 sample=${sample} source=${JSON.stringify(source)}`);
  }
});

for (const fixture of fixtures) {
  test(`baseline corpus: ${fixture.id}`, () => {
    const table = parseTable(fixture.source, fixture.options);
    assert.deepEqual(table?.sections.map(section => section.rows.length) ?? null, fixture.rows);
    if (table) {
      assert.equal(table.range.end, fixture.source.length);
      sourceContract(fixture.source, table);
    }
  });
}

test("baseline: seeded malformed documents preserve ranges and scanner snapshots (seed 0xc0ffee)", () => {
  const next = random(0xc0ffee);
  const lines = ["A|B", "-|-", "|", "", "plain", "^^|^^", "x||", "| x | y |\\", "`a|b`|😀", "[caption]", "  a|b", "\\|x|y"];
  const endings = ["\n", "\r\n", "\r"];
  for (let sample = 0; sample < 1000; sample++) {
    const options = { multiline: !!(sample & 1), rowspan: !!(sample & 2), headerless: !!(sample & 4), multibody: !!(sample & 8), autolabel: !!(sample & 16) };
    let source = sample % 2 ? "A|B\n-|-\n" : "";
    for (let i = next(16); i > 0; i--) source += lines[next(lines.length)]! + endings[next(3)]!;
    try {
      const scanner = new TableScanner(options);
      const physical = /([^\r\n]*)(\r\n|\r|\n|$)/g;
      for (const match of source.matchAll(physical)) {
        if (match.index === source.length) break;
        const before = scanner.finish();
        const snapshot = structuredClone(before);
        const accepted = scanner.push(match[1]!, match.index);
        assert.deepEqual(before, snapshot);
        if (!accepted) { assert.deepEqual(scanner.finish(), before); break; }
        if (scanner.finished) break;
      }
      const table = parseTable(source, options);
      assert.deepEqual(scanner.finish(), table);
      if (table) sourceContract(source, table);
    } catch (error) {
      throw new Error(`seed=0xc0ffee sample=${sample} options=${JSON.stringify(options)} source=${JSON.stringify(source)}`, { cause: error });
    }
  }
});
