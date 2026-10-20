import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 测试与打包共用锁定的 Rust 构建，只在字节变化时更新内嵌模块。 */
export default async function prepareWasm(): Promise<void> {
  const root = fileURLToPath(new URL("../", import.meta.url));
  execFileSync(
    "cargo",
    [
      "build",
      "--locked",
      "--release",
      "--target",
      "wasm32-unknown-unknown",
      "--manifest-path",
      resolve(root, "crates/core/Cargo.toml"),
    ],
    { cwd: root, stdio: "inherit" },
  );
  const bytes = await readFile(
    resolve(root, "crates/core/target/wasm32-unknown-unknown/release/multimd_table_core.wasm"),
  );
  const source = `// Generated from crates/core; do not edit.\nexport default ${JSON.stringify(bytes.toString("base64"))};\n`;
  const path = resolve(root, "src/internal/wasm-data.js");
  const previous = await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
  if (source !== previous) await writeFile(path, source);
  console.log(`Embedded Rust/WASM: ${bytes.length} bytes`);
}

if (import.meta.main) await prepareWasm();
