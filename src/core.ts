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
  /** 首尾物理行的原始单元格边界，包含边缘空白；精确内容位置使用 segments。 */
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

/**
 * 按递增偏移跳过代码片段；未闭合时只跳过起始反引号串。
 * 成功搜索消费完整片段；首次失败索引后缀各长度的最后位置，避免反复搜索同一后缀。
 */
function codeSpanEnd(text: string): (start: number) => number {
  let complete = false;
  let last: Map<number, number> | undefined;
  return (start) => {
    let end = start + 1;
    while (text[end] === "`") end++;
    const length = end - start;
    if (complete && (last?.get(length) ?? -1) <= start) return end;
    let cursor = end;
    while ((cursor = text.indexOf("`", cursor)) !== -1) {
      let next = cursor + 1;
      while (text[next] === "`") next++;
      if (next - cursor === length) return next;
      // 完整扫描后保留最后位置；后续成功匹配不能用较早位置覆盖它。
      if (!complete) (last ??= new Map()).set(next - cursor, cursor);
      cursor = next;
    }
    complete = true;
    return end;
  };
}

/** 连续反斜杠为奇数个时，紧随其后的标记被转义。 */
function escapedAt(text: string, offset: number): boolean {
  let start = offset;
  while (text[start - 1] === "\\") start--;
  return (offset - start) % 2 === 1;
}

/**
 * 扫描未转义且位于代码片段外的管道符。
 * 反引号必须以相同长度的连续串闭合；未闭合串不屏蔽后续管道。
 * 缺少外侧管道时补入 -1 和去尾空白后的行尾偏移。
 */
export function cellBounds(line: string): number[] {
  let pipe = line.indexOf("|");
  if (pipe === -1) return [];
  let tick = line.indexOf("`");
  const skipCode = tick === -1 ? undefined : codeSpanEnd(line);
  const pipes: number[] = [];
  // 两个游标都只向前移动；普通文本由原生字符串搜索跳过。
  while (pipe !== -1) {
    if (tick !== -1 && tick < pipe) {
      const end = escapedAt(line, tick) ? tick + 1 : skipCode!(tick);
      if (end > pipe) pipe = line.indexOf("|", end);
      tick = line.indexOf("`", end);
    } else {
      if (!escapedAt(line, pipe)) pipes.push(pipe);
      pipe = line.indexOf("|", pipe + 1);
    }
  }
  if (!pipes.length) return [];
  const end = line.trimEnd().length;
  if (pipes[0] !== 0) pipes.unshift(-1);
  if (pipes[pipes.length - 1] !== end - 1) pipes.push(end);
  return pipes;
}

interface PhysicalRow {
  text: string;
  offset: number;
  continued: boolean;
  /** 接收时缓存去掉续行标记后的边界，构造快照时复用。 */
  bounds: number[];
}
/** 普通逻辑行直接使用首行；只有实际续行时才分配后继列表。 */
interface LogicalRow extends PhysicalRow { following?: PhysicalRow[] }
interface RowGroup { kind: Section["kind"]; rows: LogicalRow[] }
/** 同一锚点在每个逻辑行只扩展一次；状态随分区结束释放。 */
interface RowSpans {
  previous: (Cell | undefined)[];
  extended: Map<Cell, number>;
  row: number;
}

/** 分隔行最多允许三列空白缩进；Tab 按四列制表位计数。 */
function delimiter(text: string, bounds: number[]): Table["columns"] | null {
  let indent = 0;
  for (const character of text) {
    if (character === " ") indent++;
    else if (character === "\t") indent += 4 - indent % 4;
    else break;
  }
  if (indent >= 4) return null;
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
  const skipCode = text.includes("`") ? codeSpanEnd(text) : undefined;
  let depth = 1;
  let end = start + 1;
  for (; end < text.length; end++) {
    if (text[end] === "\\") { end++; continue; }
    if (skipCode && text[end] === "`") { end = skipCode(end) - 1; continue; }
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
  private continuation: LogicalRow | null = null;
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
    const content = text.trimStart();
    if (!content) {
      const body = this.groups.at(-1);
      if (!this.options.multibody || this.gap || this.continuation || body?.kind !== "body")
        return false;
      this.gap = true;
      return true;
    }
    let bounds: number[] | undefined;
    if (!this.committed) {
      bounds = cellBounds(text);
      const columns = delimiter(text, bounds);
      if (columns !== null) {
        if (!this.groups.length && !this.options.headerless) return false;
        // 分隔行结束表头；未闭合的表头续行在快照中逐行回退。
        this.continuation = null;
        this.columns = columns;
        this.recordExtent(offset, text.length);
        return true;
      }
    }
    if (!this.continuation && content[0] === "[") {
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
    bounds ??= cellBounds(text);
    if (bounds.length < 2) return false;
    const continued = this.options.multiline && text.endsWith("\\");
    const line = {
      text, offset, continued,
      bounds: continued ? cellBounds(text.slice(0, -1)) : bounds,
    };
    if (this.continuation) {
      (this.continuation.following ??= []).push(line);
      if (!continued) this.continuation = null;
    } else {
      const kind = this.committed ? "body" : "head";
      let group = this.groups.at(-1);
      if (!group || group.kind !== kind || this.gap) {
        group = { kind, rows: [] };
        this.groups.push(group);
      }
      group.rows.push(line);
      if (continued) this.continuation = line;
    }
    this.gap = false;
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
      const rows: Row[] = [];
      const spans: RowSpans | undefined = this.options.rowspan
        ? { previous: [], extended: new Map(), row: 0 } : undefined;
      for (const first of group.rows) {
        const following = first.following;
        if ((following?.at(-1) ?? first).continued) {
          rows.push(materializeRow(first, undefined, columns, spans));
          if (following)
            for (const line of following) rows.push(materializeRow(line, undefined, columns, spans));
        } else rows.push(materializeRow(first, following, columns, spans));
      }
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

/** 首行决定列数和列跨度；同一分区的跨度状态在建模时接收当前行的覆盖关系。 */
function materializeRow(
  first: PhysicalRow, following: PhysicalRow[] | undefined, columns: Table["columns"],
  spans?: RowSpans,
): Row {
  const last = following?.at(-1) ?? first;
  const block = following !== undefined;
  const width = Math.max(0, first.bounds.length - 1);
  const cells: Cell[] = [];
  const previous = spans?.previous;
  const row = spans ? spans.row++ : 0;
  for (let column = 0; column < width;) {
    const begin = first.bounds[column]! + 1;
    const raw = first.text.slice(begin, first.bounds[column + 1]);
    if (!raw.length) {
      // 首部空列没有锚点；清除上一行的对应覆盖，避免跨过空洞继续合并。
      if (previous) previous[column] = undefined;
      column++;
      continue;
    }
    let next = column + 1;
    while (next < width && first.bounds[next]! + 1 === first.bounds[next + 1]) next++;
    let segments: Range[] | undefined;
    let value: string;
    if (following) {
      segments = [];
      const values: string[] = [];
      for (let part = 0; part <= following.length; part++) {
        const line = part === 0 ? first : following[part - 1]!;
        const end = line.bounds[column + 1];
        if (end === undefined) continue;
        const begin = line.bounds[column]! + 1;
        const value = line.text.slice(begin, end).trimEnd();
        const start = line.offset + begin;
        segments.push({ start, end: start + value.length });
        values.push(value);
      }
      value = values.join("\n");
    } else {
      value = raw.trim();
    }
    let origin = previous && (following ? value.trim() : value) === "^^" ? previous[column] : undefined;
    if (origin) {
      const extended = spans!.extended;
      if (extended.get(origin) !== row) {
        origin.rowspan++;
        extended.set(origin, row);
      }
    } else {
      if (!segments) {
        const start = first.offset + begin + raw.length - raw.trimStart().length;
        segments = [{ start, end: start + value.length }];
      }
      origin = {
        column,
        colspan: next - column,
        rowspan: 1,
        align: columns[column]?.align ?? null,
        wrap: columns[column]?.wrap ?? false,
        value,
        block,
        segments,
        range: {
          start: first.offset + begin,
          // 末行缺少此列时，沿用物理行末尾边界；segments 只记录实际存在的内容。
          end: last.offset + (last.bounds[column + 1] ?? last.text.length),
        },
      };
      cells.push(origin);
    }
    if (previous)
      for (let slot = column; slot < next; slot++) previous[slot] = origin;
    column = next;
  }
  if (previous) previous.length = width;
  return {
    cells,
    range: { start: first.offset, end: last.offset + last.text.length },
  };
}

/** 从字符串开头读取一个表格，首个被拒绝的物理行及其后内容归调用方。 */
export function parseTable(source: string, options: Options = {}): Table | null {
  const scanner = new TableScanner(options);
  const breaks = /\r\n|\r|\n/g;
  let offset = 0;
  while (offset < source.length) {
    const next = breaks.exec(source);
    const end = next?.index ?? source.length;
    if (!scanner.push(source.slice(offset, end), offset)) break;
    if (scanner.finished) break;
    if (!next) break;
    offset = breaks.lastIndex;
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
