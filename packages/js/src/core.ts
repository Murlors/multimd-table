import { runtime } from "./internal/backend.js";
import { expandSection as expand } from "./internal/wasm.mjs";
import type { Options, Section, ExpandedCell } from "./types.js";
export type {
  Options,
  Alignment,
  Range,
  Cell,
  Row,
  Section,
  Caption,
  Table,
  ExpandedCell,
} from "./types.js";

/** 增量扫描器；finish 返回独立快照，使用结束后须释放所持有的 Rust 内存。 */
export interface TableScanner {
  readonly options: Required<Options>;
  readonly accepted: boolean;
  readonly committed: boolean;
  readonly finished: boolean;
  /** 接收不含换行符的源行；offset 是非负安全整数，按 UTF-16 单元计数。 */
  push(source: string, offset: number): boolean;
  finish(): import("./types.js").Table | null;
  /** 幂等释放；释放后不能继续 push 或 finish，已有快照不受影响。 */
  dispose(): void;
}

export const TableScanner: {
  new (options?: Options): TableScanner;
  readonly prototype: TableScanner;
} = runtime.TableScanner;

/** 默认保留独立正文分区，并为标题生成标识符。 */
export const defaults = runtime.defaults;
/** 从字符串开头读取表格，首个被拒绝的物理行及其后内容归调用方。 */
export const parseTable = runtime.parseTable;
/** 返回未被转义或代码片段遮蔽的管道边界，坐标按 UTF-16 单元计数。 */
export const cellBounds = runtime.cellBounds;

/** 按分区展开合并范围，空洞保留 null；origin 指向输入模型。 */
export const expandSection: (section: Section) => (ExpandedCell | null)[][] = expand;
