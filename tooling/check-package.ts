import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const markedProbe = `
import assert from "node:assert/strict";
import { Marked } from "marked";
import multimd from "multimd-table/marked";
const parser = new Marked(multimd({ rowspan: true, multiline: true }));
const html = parser.parse("A|B\\n-|-\\nx||\\n^^||\\n[Caption]", { async: false });
assert.match(html, /colspan="2"/);
assert.match(html, /rowspan="2"/);
assert.match(html, /<caption[^>]*>Caption<\\/caption>/);
console.log("marked runtime passed");
`;

const markdownItProbe = `
import assert from "node:assert/strict";
import MarkdownIt from "markdown-it";
import multimd from "multimd-table/markdown-it";
const html = new MarkdownIt().use(multimd, { rowspan: true, multiline: true })
  .render("A|B\\n-|-\\nx||\\n^^||\\n[Caption]");
assert.match(html, /colspan="2"/);
assert.match(html, /rowspan="2"/);
assert.match(html, /<caption[^>]*>Caption<\\/caption>/);
console.log("markdown-it runtime passed");
`;

const mdxProbe = `
import assert from "node:assert/strict";
import { evaluate } from "@mdx-js/mdx";
import { createElement } from "react";
import * as runtime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import remarkGfm from "remark-gfm";
import multimd from "multimd-table/remark";
const { default: Content } = await evaluate("A|B\\n-|-\\n<Badge/>|{1 + 1}\\n^^|done", {
  ...runtime, remarkPlugins: [remarkGfm, [multimd, { rowspan: true }]],
});
const html = renderToStaticMarkup(createElement(Content, {
  components: { Badge: () => createElement("mark", null, "Ready") },
}));
assert.match(html, /rowspan="2"/i);
assert.match(html, /<mark>Ready<\\/mark>/);
assert.match(html, /<td>2<\\/td>/);
console.log("MDX runtime passed");
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

const markedTypes = `
import { Marked } from "marked";
import multimd from "multimd-table/marked";
const parser = new Marked(multimd({ rowspan: true, multiline: true }));
const html: string = parser.parse("A|B\\n-| -", { async: false });
void html;
`;

const markdownItTypes = `
import MarkdownIt from "markdown-it";
import multimd from "multimd-table/markdown-it";
const html: string = new MarkdownIt().use(multimd, { rowspan: true }).render("A|B\\n-| -");
void html;
`;

const mdxTypes = `
import { compile } from "@mdx-js/mdx";
import type { JSX as ReactJSX } from "react";
import multimd from "multimd-table/remark";
// MDX 3 的声明使用全局 JSX；此消费者选择 React 19 的 JSX 运行时类型。
declare global {
  namespace JSX {
    type ElementType = ReactJSX.ElementType;
    type Element = ReactJSX.Element;
    type ElementClass = ReactJSX.ElementClass;
    type IntrinsicElements = ReactJSX.IntrinsicElements;
  }
}
await compile("A|B\\n-| -", { remarkPlugins: [[multimd, { rowspan: true }]] });
`;

const consumers = {
  core: { runtime: coreProbe, types: coreTypes, dependencies: [] },
  remark: {
    runtime: remarkProbe, types: remarkTypes,
    dependencies: ["unified", "mdast-util-from-markdown", "remark-parse", "remark-gfm", "remark-rehype", "rehype-stringify"],
  },
  marked: { runtime: markedProbe, types: markedTypes, dependencies: ["marked"] },
  "markdown-it": { runtime: markdownItProbe, types: markdownItTypes, dependencies: ["markdown-it"] },
  mdx: {
    runtime: mdxProbe, types: mdxTypes,
    dependencies: ["@mdx-js/mdx", "react", "react-dom", "@types/react", "@types/react-dom", "remark-gfm", "unified", "mdast-util-from-markdown"],
  },
} as const;

try {
  // 调用方先构建；ignore-scripts 防止发布生命周期再次调用本门禁形成递归。
  const archive = join(temporary, "package.tgz");
  run([bun, "pm", "pack", "--ignore-scripts", "--filename", archive], root);
  const entries = run(["tar", "-tzf", archive], root).trim().split("\n");
  const files = new Set(entries.filter((entry) => !entry.endsWith("/")));
  for (const entry of entries) {
    assert.ok(!entry.startsWith("/") && !entry.split("/").includes(".."), `Unsafe archive path: ${entry}`);
    if (entry.endsWith("/")) {
      assert.match(entry, /^package\/(?:dist\/)?$/, `Unexpected archive directory: ${entry}`);
      continue;
    }
    assert.match(
      entry,
      /^package\/(?:package\.json|README\.md|LICENSE|NOTICE|dist\/[\w-]+\.(?:js|d\.ts))$/,
      `Unexpected packaged file: ${entry}`,
    );
    const content = run(["tar", "-xOzf", archive, entry], root);
    // 旧构建目录即使残留 map，也不能入包；发布的 JS 和声明同样不能引用它们。
    if (entry.startsWith("package/dist/")) {
      assert.ok(!/\/\/# sourceMappingURL=/.test(content), `Unexpected source map reference: ${entry}`);
    }
  }
  const required = [
    "package/package.json",
    "package/LICENSE",
    "package/NOTICE",
    "package/README.md",
    "package/dist/core.js",
    "package/dist/core.d.ts",
    "package/dist/remark.js",
    "package/dist/remark.d.ts",
    "package/dist/marked.js",
    "package/dist/marked.d.ts",
    "package/dist/markdown-it.js",
    "package/dist/markdown-it.d.ts",
  ];
  assert.deepEqual([...files].sort(), required.sort(), "Published files must match the package entries");
  console.log(`[package] archive contents passed without source maps or TS sources (${files.size} files)`);

  for (const [kind, probe] of Object.entries(consumers)) {
    const directory = join(temporary, kind);
    await mkdir(directory);
    const dependencies: Record<string, string> = {
      "multimd-table": `file:${archive}`,
      typescript: await version("typescript"),
    };
    for (const name of probe.dependencies) dependencies[name] = await version(name);
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
        "--omit=peer",
      ],
      directory,
    );
    const installed = await realpath(join(directory, "node_modules/multimd-table"));
    assert.ok(
      installed.startsWith((await realpath(directory)) + "/"),
      "Package must resolve inside the isolated consumer",
    );
    const unusedPeers = ["unified", "mdast-util-from-markdown", "marked", "markdown-it"]
      .filter((name) => !(name in dependencies));
    const isolation = `\nfor (const name of ${JSON.stringify(unusedPeers)}) {
      assert.throws(() => import.meta.resolve(name), undefined, name + " must remain absent");
    }\n`;
    await writeFile(join(directory, "runtime.mjs"), probe.runtime + isolation);
    await writeFile(join(directory, "consumer.ts"), probe.types);
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
