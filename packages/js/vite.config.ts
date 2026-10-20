import { defineConfig } from "vite-plus";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import prepareWasm from "../../tooling/prepare-wasm.ts";

// 根测试入口汇总这些项目；包内也可独立验证两种宿主条件。
export const testProjects = ["production", "development"].map((condition) => ({
  root: fileURLToPath(new URL("./", import.meta.url)),
  resolve: { conditions: ["module", "node", condition] },
  ssr: { resolve: { conditions: ["module", "node", condition] } },
  test: {
    name: condition,
    include: ["test/**/*.test.ts", "../../crates/core/bindings/transport.test.js"],
    globalSetup: ["../../tooling/prepare-wasm.ts"],
    server: { deps: { inline: true as const } },
  },
}));

export default defineConfig({
  test: { projects: testProjects },
  pack: {
    entry: [
      "src/core.ts",
      "src/writer.ts",
      "src/remark.ts",
      "src/marked.ts",
      "src/markdown-it.ts",
      "src/types.ts",
      "src/internal/backend.ts",
      "src/internal/loader.ts",
      "src/internal/wasm.mjs",
      "src/internal/wire.mjs",
    ],
    unbundle: true,
    platform: "neutral",
    target: "es2022",
    // 保留标识符，不引入需要额外发布的运行时命名辅助模块。
    minify: { mangle: false },
    failOnWarn: true,
    publint: true,
    attw: { profile: "esm-only", level: "error" },
    tsconfig: "tsconfig.build.json",
    deps: { neverBundle: [/\.mjs$/, /^node:/] },
    outputOptions: {
      entryFileNames: (chunk) =>
        chunk.facadeModuleId?.endsWith(".mjs") ? "[name].mjs" : "[name].js",
    },
    copy: {
      from: "src/internal/core.wasm",
      to: "dist/internal",
    },
    hooks: {
      async "build:prepare"() {
        await prepareWasm();
        // 仓库 README 是唯一来源；npm 包内使用可直接访问的文档链接。
        const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
        await writeFile(
          new URL("./README.md", import.meta.url),
          readme.replace(
            /\]\((docs\/|packages\/|LICENSE\))/g,
            "](https://github.com/Murlors/multimd-table/blob/main/$1",
          ),
        );
      },
    },
  },
});
