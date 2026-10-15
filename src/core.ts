/** 表格扩展选项；跨行合并、多行内容和无表头模式须显式开启。 */
export interface Options {
  multiline?: boolean;
  rowspan?: boolean;
  headerless?: boolean;
  multibody?: boolean;
  autolabel?: boolean;
}

/** 默认保留独立正文分区，并为标题生成标识符。 */
export const defaults: Readonly<Required<Options>> = Object.freeze({
  multiline: false,
  rowspan: false,
  headerless: false,
  multibody: true,
  autolabel: true,
});

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

/** 索引反引号串及其同长度闭合位置，供单元格边界和标题共用。 */
function backtickRuns(line: string): Map<number, { end: number; close?: number }> {
  const ticks = new Map<number, { end: number; close?: number }>();
  const following = new Map<number, number>();
  const runs: { start: number; end: number }[] = [];
  for (let index = 0; index < line.length;) {
    if (line[index] !== "`") { index++; continue; }
    const start = index;
    while (line[index] === "`") index++;
    runs.push({ start, end: index });
  }
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index]!;
    const length = run.end - run.start;
    ticks.set(run.start, { end: run.end, close: following.get(length) });
    // 转义只消耗第一个反引号，余下部分仍可能成为代码片段的起始串。
    if (length > 1)
      ticks.set(run.start + 1, { end: run.end, close: following.get(length - 1) });
    following.set(length, run.end);
  }
  return ticks;
}

/**
 * 扫描未转义且位于代码片段外的管道符。
 * 反引号必须以相同长度的连续串闭合；未闭合串不屏蔽后续管道。
 * 缺少外侧管道时补入 -1 和去尾空白后的行尾偏移。
 */
export function cellBounds(line: string): number[] {
  const ticks = backtickRuns(line);
  const pipes: number[] = [];
  for (let index = 0; index < line.length;) {
    if (line[index] === "\\") { index += 2; continue; }
    const run = ticks.get(index);
    if (run) { index = run.close ?? run.end; continue; }
    if (line[index] === "|") pipes.push(index);
    index++;
  }
  if (!pipes.length) return [];
  const end = line.trimEnd().length;
  if (pipes[0] !== 0) pipes.unshift(-1);
  if (pipes[pipes.length - 1] !== end - 1) pipes.push(end);
  return pipes;
}

interface PhysicalRow { text: string; offset: number; continued: boolean }
interface RowGroup { kind: Section["kind"]; rows: PhysicalRow[][] }

/** 分隔行最多允许三列空白缩进；Tab 按四列制表位计数。 */
function delimiter(text: string): Table["columns"] | null {
  let indent = 0;
  for (const character of text) {
    if (character === " ") indent++;
    else if (character === "\t") indent += 4 - indent % 4;
    else break;
  }
  if (indent >= 4) return null;
  const bounds = cellBounds(text);
  if (!bounds.length) return null;
  const columns: Table["columns"] = [];
  for (let index = 1; index < bounds.length; index++) {
    const value = text.slice(bounds[index - 1]! + 1, bounds[index]).trim();
    if (!/^:?(?:-+|=+):?\+?$/.test(value)) return null;
    const marker = value.replace(/\+$/, "");
    columns.push({
      align: marker.startsWith(":")
        ? marker.endsWith(":") ? "center" : "left"
        : marker.endsWith(":") ? "right" : null,
      wrap: value.endsWith("+"),
    });
  }
  return columns;
}

/** 只识别完整的外层方括号；内部链接与转义括号保留原文。 */
function captionAt(text: string, offset: number, autolabel: boolean): Caption | null {
  const start = text.length - text.trimStart().length;
  if (text[start] !== "[") return null;
  const ticks = backtickRuns(text);
  let depth = 1;
  let end = start + 1;
  for (; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    const run = ticks.get(end);
    if (run) { end = (run.close ?? run.end) - 1; continue; }
    if (text[end] === "[") depth++;
    if (text[end] === "]" && --depth === 0) break;
  }
  if (depth !== 0) return null;
  const suffix = text.slice(end + 1).trim();
  if (suffix && !/^\[[^\[\]\r\n]+\]$/.test(suffix)) return null;
  const content = text.slice(start + 1, end);
  if (!content.trim()) return null;
  return {
    value: content,
    id: suffix
      ? suffix.slice(1, -1).toLowerCase().replace(/\W/g, "")
      : autolabel ? content.toLowerCase().replace(/\W/g, "") : null,
    side: "top",
    range: { start: offset, end: offset + text.length },
    contentRange: { start: offset + start + 1, end: offset + end },
  };
}

/**
 * 增量识别物理行，并在 finish 时构建独立模型。
 * 外层 Markdown 边界归宿主所有；拒绝输入不会更改已接收状态。
 */
export class TableScanner {
  readonly options: Required<Options>;
  private columns: Table["columns"] | null = null;
  private groups: RowGroup[] = [];
  private continuation: PhysicalRow[] | null = null;
  private caption: Caption | null = null;
  private gap = false;
  private firstOffset: number | null = null;
  private endOffset = 0;
  private closed = false;

  constructor(options: Options = {}) { this.options = { ...defaults, ...options }; }

  /** 分隔行与至少一行内容均已接收。 */
  get accepted(): boolean { return this.committed && this.groups.length > 0; }
  /** 后置标题关闭表格，普通拒绝和快照操作不会关闭。 */
  get finished(): boolean { return this.closed; }
  /** 已接收分隔行；无表头模式可以尚未接收到正文。 */
  get committed(): boolean { return this.columns !== null; }

  /** 接收不含换行符的源行，offset 使用原始文档的 UTF-16 偏移。 */
  push(text: string, offset: number): boolean {
    if (this.closed) return false;
    if (!text.trim()) {
      const body = this.groups.at(-1);
      if (!this.options.multibody || this.gap || this.continuation || body?.kind !== "body")
        return false;
      this.gap = true;
      return true;
    }
    if (!this.committed) {
      const columns = delimiter(text);
      if (columns !== null) {
        if (!this.groups.length && !this.options.headerless) return false;
        // 分隔行结束表头；未闭合的表头续行在快照中逐行回退。
        this.continuation = null;
        this.columns = columns;
        this.recordExtent(offset, text.length);
        return true;
      }
    }
    if (!this.continuation) {
      const caption = captionAt(text, offset, this.options.autolabel);
      if (caption) {
        if (this.caption || this.gap || (!this.committed && this.groups.length > 0)) return false;
        if (this.committed && !this.accepted) return false;
        caption.side = this.committed ? "bottom" : "top";
        this.caption = caption;
        this.closed = this.committed;
        this.recordExtent(offset, text.length);
        return true;
      }
    }
    if (cellBounds(text).length < 2) return false;
    const line = { text, offset, continued: this.options.multiline && text.endsWith("\\") };
    if (this.continuation) this.continuation.push(line);
    else {
      const kind = this.committed ? "body" : "head";
      let group = this.groups.at(-1);
      if (!group || group.kind !== kind || this.gap) {
        group = { kind, rows: [] };
        this.groups.push(group);
      }
      const row = [line];
      group.rows.push(row);
      this.continuation = row;
    }
    this.gap = false;
    if (!line.continued) this.continuation = null;
    this.recordExtent(offset, text.length);
    return true;
  }

  private recordExtent(offset: number, length: number): void {
    this.firstOffset ??= offset;
    this.endOffset = offset + length;
  }

  /** 返回无共享可变状态的模型快照；未闭合续行按独立物理行保留。 */
  finish(): Table | null {
    if (!this.accepted) return null;
    const columns = this.columns!.map((column) => ({ ...column }));
    const sections = this.groups.map((group): Section => {
      const rows = group.rows.flatMap((lines) => lines.at(-1)!.continued
        ? lines.map((line) => materializeRow([line], false, columns))
        : [materializeRow(lines, lines.length > 1, columns)]);
      if (this.options.rowspan) mergeRows(rows);
      return {
        kind: group.kind,
        rows,
        range: { start: rows[0]!.range.start, end: rows.at(-1)!.range.end },
      };
    });
    return {
      type: "multimdTable",
      columns,
      caption: this.caption ? {
        ...this.caption,
        range: { ...this.caption.range },
        contentRange: { ...this.caption.contentRange },
      } : null,
      sections,
      range: { start: this.firstOffset!, end: this.endOffset },
    };
  }
}

/** 将完整逻辑行映射为单元格；首行决定列数，后续物理行只补充内容。 */
function materializeRow(lines: PhysicalRow[], block: boolean, columns: Table["columns"]): Row {
  const pieces = lines.map((line) => {
    const text = line.continued ? line.text.slice(0, -1) : line.text;
    const bounds = cellBounds(text);
    return Array.from({ length: Math.max(0, bounds.length - 1) }, (_, index) => ({
      raw: text.slice(bounds[index]! + 1, bounds[index + 1]),
      offset: line.offset + bounds[index]! + 1,
    }));
  });
  const cells: Cell[] = [];
  for (let column = 0; column < pieces[0]!.length; column++) {
    const initial = pieces[0]![column]!;
    if (!initial.raw.length) {
      const previous = cells.at(-1);
      if (previous && previous.column + previous.colspan === column) previous.colspan++;
      continue;
    }
    const segments: Range[] = [];
    const values: string[] = [];
    for (const line of pieces) {
      const piece = line[column];
      if (!piece) continue;
      const value = block ? piece.raw.trimEnd() : piece.raw.trim();
      const begin = block ? 0 : piece.raw.length - piece.raw.trimStart().length;
      segments.push({ start: piece.offset + begin, end: piece.offset + begin + value.length });
      values.push(value);
    }
    cells.push({
      column,
      colspan: 1,
      rowspan: 1,
      align: columns[column]?.align ?? null,
      wrap: columns[column]?.wrap ?? false,
      value: values.join("\n"),
      block,
      segments,
      range: { start: segments[0]!.start, end: segments.at(-1)!.end },
    });
  }
  return {
    cells,
    range: { start: lines[0]!.offset, end: lines.at(-1)!.offset + lines.at(-1)!.text.length },
  };
}

/** 合并只发生在当前分区；解析保留宽松网格，完整覆盖由 writer 校验。 */
function mergeRows(rows: Row[]): void {
  let previous = new Map<number, Cell>();
  for (const row of rows) {
    const current = new Map<number, Cell>();
    const extended = new Set<Cell>();
    row.cells = row.cells.filter((cell) => {
      const above = previous.get(cell.column);
      const inherited = cell.value.trim() === "^^" && above !== undefined;
      const origin = inherited ? above : cell;
      for (let column = cell.column; column < cell.column + cell.colspan; column++)
        current.set(column, origin);
      if (inherited && !extended.has(above)) {
        above.rowspan++;
        extended.add(above);
      }
      return !inherited;
    });
    previous = current;
  }
}

/** 从字符串开头读取一个表格，首个被拒绝的物理行及其后内容归调用方。 */
export function parseTable(source: string, options: Options = {}): Table | null {
  const scanner = new TableScanner(options);
  const lines = /([^\r\n]*)(\r\n|\r|\n|$)/g;
  for (const match of source.matchAll(lines)) {
    if (!match[0].length || !scanner.push(match[1]!, match.index!)) break;
    if (scanner.finished) break;
  }
  return scanner.finish();
}

export interface ExpandedCell { value: string; origin: Cell; inherited: boolean }

/** 按分区展开合并范围，空洞保留 null；origin 指向输入模型，位置对象各自独立。 */
export function expandSection(section: Section): (ExpandedCell | null)[][] {
  const width = section.rows.reduce((width, row) => row.cells.reduce(
    (width, cell) => Math.max(width, cell.column + cell.colspan), width,
  ), 0);
  const grid: (ExpandedCell | null)[][] = section.rows.map(() => Array(width).fill(null));
  section.rows.forEach((row, rowIndex) => {
    for (const cell of row.cells)
      for (let down = 0; down < cell.rowspan && rowIndex + down < grid.length; down++)
        for (let right = 0; right < cell.colspan; right++)
          grid[rowIndex + down]![cell.column + right] = {
            value: cell.value,
            origin: cell,
            inherited: down > 0 || right > 0,
          };
  });
  return grid;
}
