import encoded from "./wasm-data.js";
import { createCore } from "./wasm.mjs";

interface HostBuffer {
  from(source: string, encoding: "base64"): Uint8Array<ArrayBuffer>;
  from(buffer: ArrayBuffer, offset: number, length: number): {
    write(source: string, offset: number, length: number, encoding: "utf16le"): number;
  };
}
const buffer = (globalThis as typeof globalThis & { Buffer?: HostBuffer }).Buffer;

function bytes(): Uint8Array<ArrayBuffer> {
  if (buffer) return buffer.from(encoded, "base64");
  const source = atob(encoded);
  const output = new Uint8Array(source.length);
  for (let i = 0; i < source.length; i++) output[i] = source.charCodeAt(i);
  return output;
}

// 内嵌模块保持同步 API；浏览器、Worker 与 Node 共用同一份 Rust 核心。
export const runtime = createCore(new WebAssembly.Instance(new WebAssembly.Module(bytes())), {
  copyUtf16: buffer ? (source, memory, pointer) => {
    const length = source.length * 2;
    return buffer.from(memory, pointer, length).write(source, 0, length, "utf16le");
  } : undefined,
});
