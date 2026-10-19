import { runtime } from "./internal/backend.js";
export type { WriteCell, WriteRow, WriteSection, WriteCaption, WriteTable } from "./types.js";

/** 写出无尾换行的规范表格；无效网格或无法无损表示的 Markdown 抛出 RangeError。 */
export const stringifyTable = runtime.stringifyTable;
