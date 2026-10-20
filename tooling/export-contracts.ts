import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contractVectors } from "../packages/js/test/contracts.js";

// 先核验旧实现的冻结摘要，再导出完整模型供原生语言绑定验收。
const vectors = contractVectors();
const path = resolve(process.argv[2] ?? ".performance/python/vectors.json");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(vectors));
console.log(`Exported ${vectors.length} frozen parser/writer contracts to ${path}`);
