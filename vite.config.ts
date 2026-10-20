import { defineConfig } from "vite-plus";
import { testProjects } from "./packages/js/vite.config.ts";

export default defineConfig({
  defaultPackage: {
    dev: "./playground",
    build: "./playground",
    preview: "./playground",
    pack: "./packages/js",
  },
  fmt: { ignorePatterns: ["contracts/core-contracts.json"] },
  lint: { options: { typeAware: true, typeCheck: true } },
  test: {
    projects: [...testProjects, "./playground/vite.config.ts"],
  },
});
