import { loadWasm } from "./loader.js";
import { createCore } from "./wasm.mjs";

interface HostBuffer {
  from(
    buffer: ArrayBuffer,
    offset: number,
    length: number,
  ): {
    write(source: string, offset: number, length: number, encoding: "utf16le"): number;
  };
}
const buffer = (globalThis as typeof globalThis & { Buffer?: HostBuffer }).Buffer;

// Node/Bun 从包内读取；浏览器与模块 Worker 从模块相邻的资源自动加载。
export const runtime = createCore(await loadWasm(new URL("./core.wasm", import.meta.url)), {
  copyUtf16: buffer
    ? (source, memory, pointer) => {
        const length = source.length * 2;
        return buffer.from(memory, pointer, length).write(source, 0, length, "utf16le");
      }
    : undefined,
});
