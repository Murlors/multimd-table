import { initialOptions, optionKeys, type Settings } from "./examples.ts";
import { inputLimit } from "./limits.ts";
import type { Result } from "./document.ts";

export interface SharedState {
  source: string;
  options: Settings;
}

/** 只替换模型覆盖的 UTF-16 范围，保留表格后面的文档与行尾。 */
export function applyWritten(source: string, result: Result): string {
  if (!result.table || result.written === null) return source;
  return (
    source.slice(0, result.table.range.start) +
    result.written +
    source.slice(result.table.range.end)
  );
}

/** 分享状态仅放在 URL fragment，不提交给服务端；JSON 保留孤立代理项。 */
export function encodeState(state: SharedState): string {
  const encoded = encodeURIComponent(
    JSON.stringify({ v: 1, source: state.source, options: state.options }),
  );
  if (encoded.length > 12_000)
    throw new RangeError("This example is too large for a share link. Copy the Markdown instead.");
  return encoded;
}

export function decodeState(fragment: string): SharedState {
  if (fragment.length > 12_000)
    throw new RangeError("This share link is too large. Load an example to start again.");
  const value: unknown = JSON.parse(decodeURIComponent(fragment));
  if (
    !value ||
    typeof value !== "object" ||
    !("v" in value) ||
    value.v !== 1 ||
    !("source" in value) ||
    typeof value.source !== "string" ||
    value.source.length > inputLimit ||
    !("options" in value) ||
    !value.options ||
    typeof value.options !== "object" ||
    Array.isArray(value.options)
  )
    throw new Error("This share link is invalid. Load an example to start again.");
  const options = { ...initialOptions };
  const saved = value.options as Record<string, unknown>;
  for (const key of optionKeys) {
    if (key in saved && typeof saved[key] !== "boolean")
      throw new Error("This share link has invalid options.");
    if (key in saved) options[key] = saved[key] as boolean;
  }
  return { source: value.source, options };
}
