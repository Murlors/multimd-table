import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const child = Bun.spawn([
  "cargo", "build", "--locked", "--release", "--target", "wasm32-unknown-unknown",
  "--manifest-path", resolve(root, "crates/core/Cargo.toml"),
], { cwd: root, stdout: "inherit", stderr: "inherit" });
if (await child.exited) process.exit(child.exitCode ?? 1);
const bytes = await readFile(resolve(root, "crates/core/target/wasm32-unknown-unknown/release/multimd_table_core.wasm"));
// 生成模块不参与手工维护；内嵌字节避免消费者配置 Wasm 路径或异步初始化。
const source = `// Generated from crates/core; do not edit.\nexport default ${JSON.stringify(bytes.toString("base64"))};\n`;
const path = resolve(root, "src/internal/wasm-data.js");
await mkdir(resolve(root, "src/internal"), { recursive: true });
let previous = "";
try { previous = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
if (source !== previous) await writeFile(path, source);
console.log(`Embedded Rust/WASM: ${bytes.length} bytes`);
