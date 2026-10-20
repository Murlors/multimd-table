import { defineConfig } from "vite-plus";
import prepareWasm from "./tooling/prepare-wasm.ts";

export default defineConfig({
  fmt: { ignorePatterns: ["test/fixtures/core-contracts.json"] },
  lint: {
    options: { typeAware: true, typeCheck: true },
  },
  test: {
    projects: [
      ...["production", "development"].map((condition) => ({
        resolve: { conditions: ["module", "node", condition] },
        ssr: { resolve: { conditions: ["module", "node", condition] } },
        test: {
          name: condition,
          include: ["test/**/*.test.ts", "crates/core/bindings/transport.test.js"],
          globalSetup: ["./tooling/prepare-wasm.ts"],
          server: { deps: { inline: true as const } },
        },
      })),
      "./playground/vite.config.ts",
    ],
  },
  pack: {
    entry: [
      "src/core.ts",
      "src/writer.ts",
      "src/remark.ts",
      "src/marked.ts",
      "src/markdown-it.ts",
      "src/types.ts",
      "src/internal/backend.ts",
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
    deps: { neverBundle: [/\.mjs$/, /wasm-data\.js$/] },
    copy: {
      from: ["src/internal/wasm.mjs", "src/internal/wire.mjs", "src/internal/wasm-data.js"],
      to: "dist/internal",
    },
    hooks: { "build:prepare": prepareWasm },
  },
});
