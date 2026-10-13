import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), "multimd-package-"));
const bun = process.execPath;

/** 子进程只接收参数数组；失败时保留阶段信息，不回显可能含凭据的安装日志。 */
function run(command: string[], cwd: string): string {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, NODE_PATH: "" },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 120_000,
  });
  const output = new TextDecoder().decode(result.stdout);
  if (result.exitCode !== 0) {
    // 消费者探针只使用固定测试数据；安装日志可能携带 registry 凭据，不输出。
    const diagnostic = command.includes("install")
      ? "Install failed; verify registry access and the local Bun cache."
      : output + new TextDecoder().decode(result.stderr);
    throw new Error(`${command[1] ?? command[0]} failed (${result.exitCode}): ${diagnostic}`);
  }
  return output;
}

/** 从本地已验证工具链读取精确版本，消费者安装不链接开发仓库的 node_modules。 */
async function version(name: string): Promise<string> {
  return JSON.parse(await readFile(join(root, "node_modules", name, "package.json"), "utf8")).version;
}

async function json(path: string, value: unknown) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

const coreProbe = `
import assert from "node:assert/strict";
import { parseTable, expandSection, TableScanner } from "multimd-table";
const source = "A|B\\n-| -\\nx||\\n^^||";
const table = parseTable(source, { rowspan: true });
assert.ok(table);
const grid = expandSection(table.sections[1]);
assert.equal(grid[0][0].origin, grid[1][1].origin);
assert.equal(grid[1][1].inherited, true);
assert.equal(grid[0][0].origin.colspan, 2);
assert.equal(grid[0][0].origin.rowspan, 2);
const scanner = new TableScanner();
assert.equal(scanner.push("A|B", 0), true);
assert.equal(scanner.push("-|-", 4), true);
assert.ok(scanner.finish());
for (const name of ["unified", "mdast-util-from-markdown"]) {
  assert.throws(() => import.meta.resolve(name), undefined, name + " must remain absent for core-only consumers");
}
console.log("core runtime passed");
`;

const remarkProbe = `
import assert from "node:assert/strict";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import remarkMultimd from "multimd-table/remark";
const source = "A|B\\n-| -\\nx||\\n^^||\\n[Caption]";
const html = String(unified().use(remarkParse).use(remarkGfm)
  .use(remarkMultimd, { rowspan: true, multiline: true })
  .use(remarkRehype).use(rehypeStringify).processSync(source));
assert.match(html, /colspan="2"/);
assert.match(html, /rowspan="2"/);
assert.match(html, /<caption[^>]*>Caption<\\/caption>/);
assert.ok(!html.includes("^^"));
console.log("remark runtime passed");
`;

const coreTypes = `
import { parseTable, expandSection, TableScanner, type Table, type Options } from "multimd-table";
const options: Options = { rowspan: true, multiline: true };
const table: Table | null = parseTable("A|B\\n-|-", options);
const scanner = new TableScanner(options);
scanner.push("A|B", 0);
if (table) {
  const value: string | undefined = expandSection(table.sections[0]!)[0]?.[0]?.value;
  void value;
}
`;

const remarkTypes = `
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkMultimd, { type RemarkOptions, type MultimdNode } from "multimd-table/remark";
const options: RemarkOptions = { rowspan: true, multiline: true };
const tree = unified().use(remarkParse).use(remarkGfm).use(remarkMultimd, options).parse("A|B\\n-|-");
const table = tree.children.find((node): node is MultimdNode => node.type === "multimdTable");
const typed: MultimdNode | undefined = table;
void typed;
`;

try {
  // 调用方先构建；ignore-scripts 防止发布生命周期再次调用本门禁形成递归。
  const archive = join(temporary, "package.tgz");
  run([bun, "pm", "pack", "--ignore-scripts", "--filename", archive], root);
  const entries = run(["tar", "-tzf", archive], root).trim().split("\n");
  const files = new Set(entries.filter((entry) => !entry.endsWith("/")));
  const archiveContents = new Map<string, string>();
  for (const entry of entries) {
    assert.ok(!entry.startsWith("/") && !entry.split("/").includes(".."), `Unsafe archive path: ${entry}`);
    if (entry.endsWith("/")) {
      assert.match(entry, /^package\/(?:src\/|dist\/)?$/, `Unexpected archive directory: ${entry}`);
      continue;
    }
    assert.match(
      entry,
      /^package\/(?:package\.json|README\.md|LICENSE|NOTICE|src\/[\w-]+\.ts|dist\/[\w-]+\.(?:js(?:\.map)?|d\.ts(?:\.map)?))$/,
      `Unexpected packaged file: ${entry}`,
    );
    const content = run(["tar", "-xOzf", archive, entry], root);
    archiveContents.set(entry, content);
  }
  for (const required of [
    "package/package.json",
    "package/LICENSE",
    "package/NOTICE",
    "package/README.md",
    "package/dist/core.js",
    "package/dist/core.d.ts",
    "package/dist/remark.js",
    "package/dist/remark.d.ts",
  ]) {
    assert.ok(files.has(required), `Missing published entry: ${required}`);
  }
  for (const [entry, content] of archiveContents) {
    if (entry.endsWith(".map")) {
      const map = JSON.parse(content) as { sources: string[]; sourceRoot?: string; sourcesContent?: (string | null)[] };
      for (const [index, source] of map.sources.entries()) {
        const target = posix.normalize(posix.join(posix.dirname(entry), map.sourceRoot ?? "", source));
        assert.ok(
          files.has(target) || typeof map.sourcesContent?.[index] === "string",
          `Unresolvable source map: ${entry} -> ${source}`,
        );
      }
    }
    for (const match of content.matchAll(/\/\/# sourceMappingURL=([^\s]+)/g)) {
      assert.ok(files.has(posix.join(posix.dirname(entry), match[1]!)), `Missing map for ${entry}`);
    }
  }
  console.log(`[package] archive contents and source maps passed (${files.size} files)`);

  for (const kind of ["core", "remark"] as const) {
    const directory = join(temporary, kind);
    await mkdir(directory);
    const dependencies: Record<string, string> = {
      "multimd-table": `file:${archive}`,
      typescript: await version("typescript"),
    };
    if (kind === "remark") {
      for (const name of [
        "unified",
        "mdast-util-from-markdown",
        "remark-parse",
        "remark-gfm",
        "remark-rehype",
        "rehype-stringify",
      ])
        dependencies[name] = await version(name);
    }
    await json(join(directory, "package.json"), {
      name: `multimd-${kind}-consumer`,
      private: true,
      type: "module",
      dependencies,
    });
    run(
      [
        bun,
        "install",
        "--ignore-scripts",
        "--prefer-offline",
        "--no-progress",
        ...(kind === "core" ? ["--omit=peer"] : []),
      ],
      directory,
    );
    const installed = await realpath(join(directory, "node_modules/multimd-table"));
    assert.ok(
      installed.startsWith((await realpath(directory)) + "/"),
      "Package must resolve inside the isolated consumer",
    );
    await writeFile(join(directory, "runtime.mjs"), kind === "core" ? coreProbe : remarkProbe);
    await writeFile(join(directory, "consumer.ts"), kind === "core" ? coreTypes : remarkTypes);
    await json(join(directory, "tsconfig.json"), {
      compilerOptions: {
        target: "ES2022",
        module: "NodeNext",
        moduleResolution: "NodeNext",
        strict: true,
        noEmit: true,
        skipLibCheck: false,
        types: [],
      },
      files: ["consumer.ts"],
    });
    run([bun, "--no-install", "runtime.mjs"], directory);
    run(["node", "runtime.mjs"], directory);
    run([bun, join(directory, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"], directory);
    console.log(`[package] ${kind}: clean install, Bun, Node and TypeScript passed`);
  }
} finally {
  // 只删除本脚本创建的随机临时目录，不触碰开发仓库或调用方目录。
  await rm(temporary, { recursive: true, force: true });
}
