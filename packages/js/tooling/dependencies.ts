import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 读取本包或根共享工具的实际版本，同时兼容隔离安装与提升安装。 */
export async function version(name: string): Promise<string> {
  const packageRoot = fileURLToPath(new URL("../", import.meta.url));
  const root = fileURLToPath(new URL("../../../", import.meta.url));
  const manifest = await readFile(
    resolve(packageRoot, "node_modules", name, "package.json"),
    "utf8",
  ).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return readFile(resolve(root, "node_modules", name, "package.json"), "utf8");
  });
  return JSON.parse(manifest).version;
}
