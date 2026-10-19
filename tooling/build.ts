import { copyFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
for (const command of [
  [process.execPath, "tooling/prepare-wasm.ts"],
  [process.execPath, "node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"],
  [process.execPath, "build", "src/core.ts", "src/writer.ts", "src/remark.ts", "src/marked.ts", "src/markdown-it.ts", "src/internal/backend.ts", "--no-bundle", "--minify", "--keep-names", "--format=esm", "--target=browser", "--root=src", "--outdir=dist"],
]) {
  const child = Bun.spawn(command, { cwd: root, stdout: "inherit", stderr: "inherit" });
  if (await child.exited) process.exit(child.exitCode ?? 1);
}
await mkdir(resolve(root, "dist/internal"), { recursive: true });
await Promise.all(["wasm.mjs", "wire.mjs", "wasm-data.js"].map(name => copyFile(resolve(root, "src/internal", name), resolve(root, "dist/internal", name))));
