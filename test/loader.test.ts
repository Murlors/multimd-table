import { expect, test, vi } from "vite-plus/test";
import { loadWasm } from "../src/internal/loader.js";

const emptyModule = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]);

test("loads the package file without HTTP or a caller-supplied path", async () => {
  const instance = await loadWasm(new URL("../src/internal/core.wasm", import.meta.url));
  expect(instance.exports.mm_parse_compact).toBeTypeOf("function");
  expect(instance.exports.mm_write).toBeTypeOf("function");
});

test("accepts bundler-inlined bytes without fetching a data URL", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    const instance = await loadWasm(new URL("data:application/wasm;base64,AGFzbQEAAAA="));
    expect(instance.exports).toEqual({});
    expect(fetch).not.toHaveBeenCalled();
    await expect(loadWasm(new URL("data:application/wasm,invalid"))).rejects.toThrow("Base64");
  } finally {
    fetch.mockRestore();
  }
});

test.each(["application/wasm", "application/wasm; charset=binary", "application/octet-stream"])(
  "loads HTTP bytes served with %s",
  async (mime) => {
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response(emptyModule, { headers: { "content-type": mime } }));
    try {
      expect((await loadWasm(new URL("https://example.test/core.wasm"))).exports).toEqual({});
    } finally {
      fetch.mockRestore();
    }
  },
);

test("reports HTTP and compilation failures instead of hiding them", async () => {
  const fetch = vi.spyOn(globalThis, "fetch");
  try {
    fetch.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(loadWasm(new URL("https://example.test/core.wasm"))).rejects.toThrow("404");
    for (const mime of ["application/wasm", "application/octet-stream"]) {
      fetch.mockResolvedValueOnce(new Response("invalid", { headers: { "content-type": mime } }));
      await expect(loadWasm(new URL("https://example.test/core.wasm"))).rejects.toBeInstanceOf(
        WebAssembly.CompileError,
      );
    }
  } finally {
    fetch.mockRestore();
  }
});
