import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { contractVectors } from "../packages/js/test/contracts.js";
import { optionCases, syntaxCases } from "../packages/js/test/cases.js";

// 先核验旧实现的冻结摘要，再导出完整模型供原生语言绑定验收。
const vectors = contractVectors();
const path = resolve(process.argv[2] ?? ".performance/python/vectors.json");
await mkdir(dirname(path), { recursive: true });
await writeFile(path, JSON.stringify(vectors));
console.log(`Exported ${vectors.length} frozen parser/writer contracts to ${path}`);
// 复用手写 HTML 预期，避免 Python 适配器以自身输出作为验收依据。
const adapters = [...syntaxCases];
for (let flags = 0; flags < 32; flags++) {
  const options = {
    multiline: !!(flags & 1),
    rowspan: !!(flags & 2),
    headerless: !!(flags & 4),
    multibody: !!(flags & 8),
    autolabel: !!(flags & 16),
  };
  for (const [index, fixture] of optionCases(options).entries())
    adapters.push({ name: `options ${flags}, case ${index}`, ...fixture, options });
}
await writeFile(resolve(dirname(path), "adapters.json"), JSON.stringify(adapters));
console.log(`Exported ${adapters.length} shared adapter HTML contracts`);
