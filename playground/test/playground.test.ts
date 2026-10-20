import { expect, test } from "vite-plus/test";
import { readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluate } from "../src/document.ts";
import { applyWritten, decodeState, encodeState } from "../src/state.ts";
import { examples, initialOptions } from "../src/examples.ts";
import { inputLimit } from "../src/limits.ts";
import { parseTable } from "multimd-table-release";

test("the demo resolves its pinned npm release instead of the local workspace", () => {
  const entry = realpathSync(createRequire(import.meta.url).resolve("multimd-table-release"));
  const workspace = realpathSync(fileURLToPath(new URL("../../packages/js", import.meta.url)));
  expect(entry.startsWith(workspace + sep)).toBe(false);
  const installed = JSON.parse(readFileSync(resolve(dirname(entry), "../package.json"), "utf8"));
  const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  expect(installed.name).toBe("multimd-table");
  expect(manifest.dependencies["multimd-table-release"]).toBe(
    `npm:${installed.name}@${installed.version}`,
  );
});

test("every published-package example parses, renders and writes back", () => {
  for (const example of examples) {
    const result = evaluate(example.source, example.options);
    expect(result.table).not.toBeNull();
    expect(result.html).toContain("<table>");
    expect(result.writeError).toBeNull();
    expect(result.written).not.toBeNull();
    expect(parseTable(result.written!, example.options)).not.toBeNull();
  }
  const merged = evaluate(examples[0]!.source, examples[0]!.options);
  expect(merged.html).toContain('rowspan="2"');
  expect(merged.html).toContain('colspan="2"');
  expect(merged.html).toContain("<caption");
  expect(merged.table!.sections).toHaveLength(3);
});

test("writing back preserves the unparsed suffix including CRLF and another table", () => {
  const prefix = "A|B\r\n-|-\r\n😀||";
  const suffix = "\r\n\r\n## Keep this\r\n\r\nX|Y\r\n-|-\r\nx|y";
  const result = evaluate(prefix + suffix, initialOptions);
  const output = applyWritten(prefix + suffix, result);
  expect(output).toBe(result.written + suffix);
  const absent = evaluate("A paragraph before a table.\n\nA|B\n-|-", initialOptions);
  expect(absent.table).toBeNull();
  expect(absent.html).toContain("<table>");
  expect(applyWritten("unchanged", absent)).toBe("unchanged");
});

test("HTML remains text and dangerous Markdown links do not become executable HTML", () => {
  const result = evaluate(
    'A|B\n-|-\n<script>alert(1)</script>|<img src=x onerror="alert(1)">\n[bad](javascript:alert(1))|safe',
    initialOptions,
  );
  expect(result.html).not.toContain("<script>");
  expect(result.html).not.toContain("<img");
  expect(result.html).not.toContain('href="javascript:');
  expect(result.html).toContain("&lt;script&gt;");
});

test("share links retain UTF-16 and options and reject malformed or oversized states", () => {
  const state = {
    source: "A|B\n-|-\n\ud800|😀",
    options: { ...initialOptions, autolabel: false, multiline: true },
  };
  expect(decodeState(encodeState(state))).toEqual(state);
  for (const fragment of [
    "%",
    "null",
    encodeURIComponent(JSON.stringify({ v: 2, source: "test", options: {} })),
    encodeURIComponent(JSON.stringify({ v: 1, source: "test", options: { rowspan: "true" } })),
  ]) {
    expect(() => decodeState(fragment)).toThrow();
  }
  expect(() => encodeState({ ...state, source: "x".repeat(12_001) })).toThrow("too large");
  expect(() => evaluate("x".repeat(inputLimit + 1), initialOptions)).toThrow("100,000");
});
