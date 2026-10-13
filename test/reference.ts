import { createRequire } from "node:module";
import type { Options } from "../src/core.js";

const require = createRequire(import.meta.url);
// 上游 4.2.3 使用旧宿主 API；固定原来的 v13 参考环境，不改写新宿主来迁就它。
const MarkdownIt = require("markdown-it-reference");
const upstream = require("markdown-it-multimd-table");

/** 用固定的上游实现生成表格语法参考结果，每份文档使用独立解析器。 */
export function renderReference(source: string, options: Options = {}): string {
  const result: unknown = new MarkdownIt().use(upstream, options).render(source);
  if (typeof result !== "string") throw new TypeError("Reference renderer must return HTML");
  return result;
}
