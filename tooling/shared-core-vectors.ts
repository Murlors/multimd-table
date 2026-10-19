import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { contractVectors } from "../test/contracts.js";
import { fixtures } from "./performance/corpus.js";

const root = resolve(import.meta.dir, "..");
const vectors = contractVectors();
const directory = resolve(root, ".performance/shared-core");
await mkdir(directory, { recursive: true });
const path = resolve(directory, "vectors.json");
await writeFile(path, JSON.stringify(vectors));
await writeFile(resolve(directory, "performance-fixtures.json"), JSON.stringify(fixtures));
console.log(`WASM: ${vectors.length} models/writer results and 7 Unicode boundaries match frozen contracts`);
const python = Bun.spawn(["python3", resolve(root, "crates/core/bindings/python.py"), path], { stdout: "inherit", stderr: "inherit" });
const pythonExit = await python.exited;
if (pythonExit) process.exit(pythonExit);
const go = Bun.spawn(["go", "test", "-count=1", "./..."], {
  cwd: resolve(root, "crates/core/bindings/go"),
  env: { ...process.env, MULTIMD_VECTORS: path }, stdout: "inherit", stderr: "inherit",
});
process.exit(await go.exited);
