/** 导入阶段初始化同一份 WASM；普通解析、扫描和写回调用保持同步。 */
export async function loadWasm(url: URL): Promise<WebAssembly.Instance> {
  if (url.protocol === "file:") {
    const { readFile } = await import("node:fs/promises");
    return (await WebAssembly.instantiate(await readFile(url))).instance;
  }
  // 打包器可以将独立资源内联；直接解码避免 CSP 将 data URL 当成网络请求拦截。
  if (url.protocol === "data:") {
    const comma = url.href.indexOf(",");
    if (comma < 0 || !url.href.slice(0, comma).endsWith(";base64"))
      throw new TypeError("Expected a Base64 WebAssembly data URL");
    const binary = atob(url.href.slice(comma + 1));
    const bytes = Uint8Array.from(binary, (value) => value.charCodeAt(0));
    return (await WebAssembly.instantiate(bytes)).instance;
  }
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Unable to load WebAssembly (${response.status})`);
  // 静态主机可能没有 WASM MIME；只在 MIME 正确时使用流式编译，不吞掉编译错误。
  return (
    response.headers.get("content-type") === "application/wasm"
      ? await WebAssembly.instantiateStreaming(response)
      : await WebAssembly.instantiate(await response.arrayBuffer())
  ).instance;
}
