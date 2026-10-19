/** 表格扩展选项；跨行合并、多行内容和无表头模式须显式开启。 */
export interface Options {
  multiline?: boolean;
  rowspan?: boolean;
  headerless?: boolean;
  multibody?: boolean;
  autolabel?: boolean;
}

export type Alignment = "left" | "center" | "right" | null;
/** UTF-16 半开区间，可直接用于 JavaScript 字符串切片。 */
export interface Range { start: number; end: number }
export interface Cell {
  column: number;
  colspan: number;
  rowspan: number;
  align: Alignment;
  wrap: boolean;
  /** 未解释的 Markdown；内联和块级语义由宿主处理。 */
  value: string;
  block: boolean;
  /** 内容各物理行的位置；以换行符连接对应切片即可还原 value。 */
  segments: Range[];
  /** 首尾物理行的原始单元格边界，包含边缘空白。 */
  range: Range;
}
export interface Row { cells: Cell[]; range: Range }
export interface Section { kind: "head" | "body"; rows: Row[]; range: Range }
export interface Caption {
  value: string;
  id: string | null;
  side: "top" | "bottom";
  range: Range;
  contentRange: Range;
}
export interface Table {
  type: "multimdTable";
  columns: { align: Alignment; wrap: boolean }[];
  caption: Caption | null;
  sections: Section[];
  range: Range;
}
export interface ExpandedCell { value: string; origin: Cell; inherited: boolean }

/** 写出模型无需源文位置；宿主先把单元格内容序列化为 Markdown。 */
export interface WriteCell {
  column: number;
  colspan?: number;
  rowspan?: number;
  value: string;
  block?: boolean;
}
export interface WriteRow { cells: readonly WriteCell[] }
export interface WriteSection { kind: "head" | "body"; rows: readonly WriteRow[] }
export interface WriteCaption {
  value: string;
  /** undefined 使用自动标题 ID；null 不生成 ID，读取时须关闭 autolabel。 */
  id?: string | null;
  side: "top" | "bottom";
}
export interface WriteTable {
  columns: readonly { align: Alignment; wrap?: boolean }[];
  sections: readonly WriteSection[];
  caption?: WriteCaption | null;
}
