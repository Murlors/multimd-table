import { defineConfig } from "vite-plus";

export default defineConfig({
  base: "./",
  server: { host: "127.0.0.1", port: 4173, strictPort: true },
  preview: { host: "127.0.0.1", port: 4173, strictPort: true },
  worker: { format: "es" },
  test: { name: "playground", include: ["test/**/*.test.ts"] },
});
