import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 测试与打包共用锁定的 Rust 构建，只在字节变化时更新独立 WASM。 */
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
  const path = resolve(root, "packages/js/src/internal/core.wasm");
  const previous = await readFile(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return Buffer.alloc(0);
  });
  if (!bytes.equals(previous)) await writeFile(path, bytes);
  console.log(`Rust/WASM: ${bytes.length} bytes`);
}

if (import.meta.main) await prepareWasm();
