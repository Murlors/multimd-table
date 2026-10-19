import { readFileSync } from "node:fs";
import { Buffer } from "node:buffer";
import { createCore, expandSection } from "./wasm.mjs";

const bytes = readFileSync(new URL("../target/wasm32-unknown-unknown/release/multimd_table_core.wasm", import.meta.url));
const instance = new WebAssembly.Instance(new WebAssembly.Module(bytes));
// 大字符串用宿主标准 UTF-16 搬运；小行保留直接复制，仍调用同一个 WASM 核心。
export const core = createCore(instance, {
  copyUtf16(source, buffer, pointer) {
    const bytes = source.length * 2;
    return Buffer.from(buffer, pointer, bytes).write(source, 0, bytes, "utf16le");
  },
});
export const { defaults, TableScanner, parseTable, cellBounds, stringifyTable, disposeScanners } = core;
export { expandSection };
