import { expect, test } from "vite-plus/test";
import { Buffer } from "node:buffer";
import { Reader } from "./wire.mjs";
import { createCore } from "./wasm.mjs";

const words = (...values) => {
  const bytes = new Uint8Array(values.length * 4);
  const view = new DataView(bytes.buffer);
  values.forEach((value, index) => view.setUint32(index * 4, value, true));
  return bytes;
};
const text = (value) => Buffer.concat([words(value.length), Buffer.from(value, "utf16le")]);
const read = (bytes, decode) => {
  const reader = new Reader(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return reader.complete(decode(reader));
};

// 独立协议样本：一字符 caption id 使后续整数非四字节对齐，末格包含两个片段。
const source = "[x]\na|b\nc\n";
const tableBytes = Buffer.concat([
  words(1, 2, 1, 0, 3, 1, 1, 1),
  text("x"),
  words(0, 0, 3, 1, 2, 1, 1, 4, 9, 1, 4, 9, 2),
  words(0, 1, 1, 0, 4, 5, 1, 4, 5),
  words(1, 1, 1, 1, 6, 9, 2, 6, 7, 8, 9),
  words(0, 9),
]);
const decodeTable = (reader) => reader.table((start, end) => source.slice(start, end));

test("compact response preserves unaligned fields and rejects every truncation and trailing bytes", () => {
  const table = read(tableBytes, decodeTable);
  expect(table.caption).toEqual({
    value: "x",
    id: "x",
    side: "top",
    range: { start: 0, end: 3 },
    contentRange: { start: 1, end: 2 },
  });
  expect(table.sections).toEqual([
    {
      kind: "body",
      range: { start: 4, end: 9 },
      rows: [
        {
          range: { start: 4, end: 9 },
          cells: [
            {
              column: 0,
              colspan: 1,
              rowspan: 1,
              align: "left",
              wrap: false,
              block: false,
              range: { start: 4, end: 5 },
              segments: [{ start: 4, end: 5 }],
              value: "a",
            },
            {
              column: 1,
              colspan: 1,
              rowspan: 1,
              align: "right",
              wrap: true,
              block: true,
              range: { start: 6, end: 9 },
              segments: [
                { start: 6, end: 7 },
                { start: 8, end: 9 },
              ],
              value: "b\nc",
            },
          ],
        },
      ],
    },
  ]);
  for (let end = 0; end < tableBytes.length; end++) {
    expect(() => read(tableBytes.subarray(0, end), decodeTable)).toThrow(RangeError);
  }
  expect(() => read(Buffer.concat([tableBytes, words(123)]), decodeTable)).toThrow(
    "Trailing response bytes",
  );
});

test("shared UTF-16 decoder preserves BOM and isolated surrogates across independent readers", () => {
  for (const value of [
    "\ufeff" + "😀".repeat(80),
    "x".repeat(80) + "\ud800",
    "\udc00" + "y".repeat(80),
    "valid after fallback".repeat(8),
  ]) {
    expect(read(Buffer.concat([words(0), text(value)]), (reader) => reader.writeResult())).toBe(
      value,
    );
  }
});

test("mixed compact protocol versions fail before interpreting table fields", () => {
  for (const format of [2, 3]) {
    expect(() => read(words(format), decodeTable)).toThrow("Unsupported compact table format");
  }
});

test("bounds decoding preserves signed sentinels and rejects truncated or extra fields", () => {
  const bytes = words(3, 0xffffffff, 2, 4);
  expect(read(bytes, (reader) => reader.bounds())).toEqual([-1, 2, 4]);
  expect(read(words(0), (reader) => reader.bounds())).toEqual([]);
  for (let end = 0; end < bytes.length; end++) {
    expect(() => read(bytes.subarray(0, end), (reader) => reader.bounds())).toThrow(RangeError);
  }
  expect(() => read(Buffer.concat([bytes, words(123)]), (reader) => reader.bounds())).toThrow(
    "Trailing response bytes",
  );
});

// 假 ABI 只记录所有权，不解析 Markdown；这些测试无需先构建 Rust。
function binding(response, options) {
  const memory = { buffer: new ArrayBuffer(65536) };
  new Uint8Array(memory.buffer, 1, response.length).set(response);
  const freed = [];
  const exports = {
    memory,
    mm_alloc: () => 1024,
    mm_free: (pointer, length) => freed.push(["input", pointer, length]),
    mm_parse_compact: () => 7,
    mm_write: () => 7,
    mm_result_ptr: () => 1,
    mm_result_len: () => response.length,
    mm_result_free: (pointer) => freed.push(["result", pointer]),
    mm_scanner_new: () => 99,
    mm_scanner_options: () => {},
    mm_scanner_push: () => 7,
    mm_scanner_finish_compact: () => 7,
    mm_scanner_free: (pointer) => freed.push(["scanner", pointer]),
    mm_profile_write_new: () => 99,
    mm_profile_write_free: (pointer) => freed.push(["model", pointer]),
  };
  return { core: createCore({ exports }, options), freed, memory, exports };
}

test("input transport writes exact little-endian UTF-16 including empty input and isolated surrogates", () => {
  const { core, memory, exports } = binding(words(0));
  for (const source of ["", "a😀\ud800\ufeff"]) {
    exports.mm_parse_compact = (pointer, length) => {
      expect(length).toBe(source.length);
      expect([...new Uint8Array(memory.buffer, pointer, length * 2)]).toEqual([
        ...Buffer.from(source, "utf16le"),
      ]);
      return 7;
    };
    expect(core.parseTable(source)).toBeNull();
  }
});

test("virtual source positions preserve large, unordered and duplicate host offsets in independent snapshots", () => {
  const response = words(
    1,
    2,
    0,
    0,
    0,
    0,
    0,
    1,
    1,
    0,
    7,
    1,
    0,
    7,
    2,
    0,
    1,
    1,
    1,
    0,
    5,
    2,
    0,
    1,
    4,
    5,
    1,
    1,
    1,
    1,
    2,
    7,
    2,
    2,
    3,
    6,
    7,
    0,
    7,
  );
  const { core, freed } = binding(response);
  const scanner = new core.TableScanner({ multiline: true });
  try {
    // 假 ABI 接受任意行：专门验证绑定的坐标查找，不复制 Rust 语法判断。
    const base = 0x1_0000_0000;
    for (const [line, offset] of [
      ["A|B", base + 4],
      ["C|D", base + 8],
      ["a|b", base + 4],
      ["----", 0],
    ])
      scanner.push(line, offset);
    const first = scanner.finish();
    expect(first.sections[0].rows[0].cells.map((cell) => cell.value)).toEqual(["A\nC", "B\nD"]);
    first.sections[0].rows[0].cells[0].segments[0].start = 1000;
    const next = scanner.finish();
    expect(next.sections[0].rows[0].cells[0].segments[0].start).toBe(base + 4);
    expect(next.sections[0].rows[0].cells.map((cell) => cell.value)).toEqual(["A\nC", "B\nD"]);
  } finally {
    scanner.dispose();
  }
  expect(freed.at(-1)).toEqual(["scanner", 99]);
});

test("owned responses and input buffers are released on success and decode failure", () => {
  for (const response of [words(0), tableBytes.subarray(0, -1), words(0, 123)]) {
    const { core, freed } = binding(response);
    if (response.length === 4) expect(core.parseTable("A|B")).toBeNull();
    else expect(() => core.parseTable("A|B")).toThrow();
    expect(freed).toEqual([
      ["result", 7],
      ["input", 1024, 3],
    ]);
  }
});

test("native writer errors release both response and request before reaching the caller", () => {
  const { core, freed } = binding(Buffer.concat([words(1), text("unrepresentable table")]));
  expect(() => core.stringifyTable({ columns: [], sections: [] })).toThrow("unrepresentable table");
  expect(freed).toEqual([
    ["result", 7],
    ["input", 1024, 6],
  ]);
});

test("input copy failure releases the input without acquiring a response", () => {
  const { core, freed } = binding(words(0), {
    copyUtf16() {
      throw new Error("copy failed");
    },
  });
  expect(() => core.parseTable("x".repeat(16384))).toThrow("copy failed");
  expect(freed).toEqual([["input", 1024, 16384]]);
});

test("diagnostic responses remain borrowed until the probe releases model and input in order", () => {
  const { core, freed } = binding(Buffer.concat([words(0), text("result")]));
  const probe = core.profileWrite({ columns: [], sections: [] });
  try {
    expect(probe.stages.decode()).toBe("result");
    expect(probe.stages.decode()).toBe("result");
    expect(freed).toEqual([]);
  } finally {
    probe.dispose();
  }
  expect(freed).toEqual([
    ["result", 7],
    ["model", 99],
    ["input", 1024, 6],
  ]);
});
