import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dir, "../../..");
const [argument, ...tests] = process.argv.slice(2);
assert.ok(
  argument && tests.length,
  "Usage: bun packages/js/tooling/check-consumer.ts <project> <test files...>",
);
const project = resolve(argument);
const archive = join(root, ".performance/package-acceptance/package.tgz");
const acceptance = JSON.parse(await readFile(join(dirname(archive), "report.json"), "utf8"));
const sha256 = createHash("sha256")
  .update(await readFile(archive))
  .digest("hex");
assert.equal(sha256, acceptance.archive.sha256, "Run verify:package before consuming the archive");
await mkdir(join(root, ".performance"), { recursive: true });
const output = await mkdtemp(join(root, ".performance/consumer-"));

function run(command: string[], cwd: string) {
  const child = Bun.spawnSync(command, {
    cwd,
    stdout: "inherit",
    stderr: "inherit",
    timeout: 120000,
  });
  assert.equal(child.exitCode, 0, "Consumer command failed");
}
run(["tar", "-xzf", archive, "-C", output], root);
const entries = tests.map((path) => {
  const entry = resolve(project, path),
    local = relative(project, entry);
  assert.ok(
    !isAbsolute(local) && local !== ".." && !local.startsWith("../"),
    "Tests must belong to the consumer project",
  );
  return entry;
});
const routes = ["core", "writer", "remark", "marked", "markdown-it"].map((entry) => {
  const specifier = entry === "core" ? "multimd-table" : `multimd-table/${entry}`;
  return {
    specifier,
    original: Bun.resolveSync(specifier, project),
    candidate: pathToFileURL(join(output, "package/dist", `${entry}.js`)).href,
  };
});
const preload = join(output, "package-preload.mjs");
// 只做模块入口映射，工厂直接返回 tarball 的真实导出，不替换任何库行为。
// 保留消费者原始文件路径，动态 JSON、Worker URL 和编辑器依赖仍按其自身环境加载。
await writeFile(
  preload,
  `
import { mock, afterEach } from "bun:test";
import { createRequire } from "node:module";
import { runtime } from "./package/dist/internal/backend.js";
for (const route of ${JSON.stringify(routes)}) {
  const actual = await import(route.candidate);
  mock.module(route.original, () => actual);
  mock.module(route.specifier, () => actual);
}
const require = createRequire(${JSON.stringify(join(project, "package.json"))});
if (require("multimd-table").parseTable !== runtime.parseTable) throw new Error("Consumer did not resolve the packed Rust backend");
afterEach(() => {
  if (runtime.activeScanners()) throw new Error("Consumer left native scanners alive");
});
`,
);
for (const entry of entries) {
  run([process.execPath, "test", "--preload", preload, entry], project);
}
await writeFile(
  join(output, "report.json"),
  JSON.stringify(
    {
      createdAt: new Date().toISOString(),
      project,
      tests,
      archiveSha256: sha256,
      passed: true,
    },
    null,
    2,
  ) + "\n",
);
console.log(`Consumer package acceptance passed: ${output}`);
