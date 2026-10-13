/** 与上游 4.2.3 一致；行合并、多行内容和无表头须显式开启。 */
export interface Options {
  multiline?: boolean;
  rowspan?: boolean;
  headerless?: boolean;
  multibody?: boolean;
  autolabel?: boolean;
}
export const defaults: Readonly<Required<Options>> = Object.freeze({
  multiline: false,
  rowspan: false,
  headerless: false,
  multibody: true,
  autolabel: true,
});
export type Alignment = "left" | "center" | "right" | null;
/** UTF-16 半开区间，与 JavaScript 字符串和 unist offset 保持一致。 */
export interface Range {
  start: number;
  end: number;
}
export interface Cell {
  column: number;
  colspan: number;
  rowspan: number;
  align: Alignment;
  wrap: boolean;
  /** 原始 Markdown 内容；由宿主解析内联/块级语法。 */
  value: string;
  block: boolean;
  /** 多行单元格的各段源文位置，不包含管道符。 */
  segments: Range[];
  range: Range;
}
export interface Row {
  cells: Cell[];
  range: Range;
}
export interface Section {
  kind: "head" | "body";
  rows: Row[];
  range: Range;
}
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
interface Line {
  value: string;
  offset: number;
}
interface RawRow {
  line: Line;
  bounds: number[];
  continued: boolean;
  kind: "head" | "body";
  group: number;
  parts?: RawRow[];
}
type Phase =
  "start" | "caption" | "headers" | "bodyStart" | "body" | "gap" | "done";

/**
 * 返回行内 UTF-16 管道边界，遵循上游的代码与转义规则。
 * 无外侧管道时补入 -1 或去尾空白后的行尾偏移；相邻边界之间是单元格原文。
 */
export function cellBounds(line: string): number[] {
  const start = line.search(/\S|$/);
  const end = line.trimEnd().length;
  const bounds: number[] = [];
  let escaped = false,
    code = false,
    serial = 0;
  for (let pos = start; pos < end; pos++) {
    const char = line[pos];
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "`") {
      let next = pos;
      while (line[next + 1] === "`") next++;
      if (next > pos) {
        if (!code) {
          if (serial === 0) serial = next - pos;
          else if (serial === next - pos) serial = 0;
        }
        pos = next;
      } else if (code || (!escaped && !serial)) code = !code;
    } else if (char === "|" && !code && !escaped) bounds.push(pos);
    escaped = false;
  }
  if (!bounds.length) return bounds;
  // 保留首列缩进，供多行单元格的块级 Markdown 使用。
  if (bounds[0]! > 0) bounds.unshift(-1);
  if (bounds[bounds.length - 1]! < end - 1) bounds.push(end);
  return bounds;
}

function separator(value: string, bounds: number[]): Table["columns"] | null {
  // Tab 推进到下一个四列缩进点；前面有一至三个空格时同样属于代码缩进。
  if (/^(?: {4}| {0,3}\t)/.test(value)) return null;
  // 上游允许单个管道作为零列分隔行；正文列数不由分隔行限制。
  if (bounds.length === 0) return null;
  const columns: Table["columns"] = [];
  for (let i = 0; i < bounds.length - 1; i++) {
    const text = value.slice(bounds[i]! + 1, bounds[i + 1]).trim();
    if (!/^:?(-+|=+):?\+?$/.test(text)) return null;
    const wrap = text.endsWith("+");
    const marker = wrap ? text.slice(0, -1) : text;
    const left = marker.startsWith(":"),
      right = marker.endsWith(":");
    columns.push({
      align: left && right ? "center" : left ? "left" : right ? "right" : null,
      wrap,
    });
  }
  return columns;
}

/** 增量表格识别器。宿主负责代码围栏、列表、引用等外层 Markdown 边界。 */
export class TableScanner {
  readonly options: Required<Options>;
  private phase: Phase = "start";
  private rows: RawRow[] = [];
  private columns: Table["columns"] | null = null;
  private caption: Caption | null = null;
  private group = 0;
  private firstOffset = 0;
  private endOffset = 0;
  constructor(options: Options = {}) {
    this.options = { ...defaults, ...options };
  }

  /** 已有分隔行和至少一行内容，finish() 可返回模型。 */
  get accepted(): boolean {
    return this.columns !== null && this.rows.length > 0;
  }
  /** 后置标题已终结表格；普通拒绝和 finish() 不会关闭识别器。 */
  get finished(): boolean {
    return this.phase === "done";
  }
  /** 已消费分隔行；无表头且尚无正文时可能仍未 accepted。 */
  get committed(): boolean {
    return this.columns !== null;
  }

  /** 消费不含换行符的一行及其 UTF-16 源偏移；拒绝时不修改状态，便于宿主回退。 */
  push(value: string, offset: number): boolean {
    if (this.finished) return false;
    const captionAllowed =
      this.phase === "start" ||
      this.phase === "bodyStart" ||
      this.phase === "body" ||
      this.phase === "gap";
    const captionMatch = captionAllowed
      ? /^\s*\[(.+?)\](\[([^\[\]]+)\])?\s*$/.exec(value)
      : null;
    if (captionAllowed && captionMatch) {
      // 上游优先前置标题；后置标题保留在表格外。
      if (this.caption) return false;
      const top = this.phase === "start";
      this.caption = {
        value: captionMatch[1]!,
        id:
          !this.options.autolabel && !captionMatch[2]
            ? null
            : (captionMatch[2] || captionMatch[1]!)
                .toLowerCase()
                .replace(/\W+/g, ""),
        side: top ? "top" : "bottom",
        range: { start: offset, end: offset + value.length },
        contentRange: {
          start: offset + value.indexOf("[") + 1,
          end: offset + value.indexOf("[") + 1 + captionMatch[1]!.length,
        },
      };
      if (top) this.firstOffset = offset;
      this.endOffset = offset + value.length;
      this.phase = top ? "caption" : "done";
      return true;
    }
    const canSeparate =
      this.phase === "headers" ||
      (this.options.headerless &&
        (this.phase === "start" || this.phase === "caption"));
    const bounds = cellBounds(value);
    const columns = canSeparate ? separator(value, bounds) : null;
    if (columns) {
      if (this.phase === "start") this.firstOffset = offset;
      this.columns = columns;
      this.phase = "bodyStart";
      this.group++;
      this.endOffset = offset + value.length;
      return true;
    }
    if (!value.trim()) {
      if (this.phase !== "body" || !this.options.multibody) return false;
      this.phase = "gap";
      this.group++;
      return true;
    }
    // 上游先验证原始行，再移除续行反斜杠。
    if (bounds.length < 2) return false;
    const continued = this.options.multiline && value.endsWith("\\");
    const content = continued ? value.slice(0, -1).trimEnd() : value;
    const kind = this.columns ? "body" : "head";
    if (this.phase === "start") this.firstOffset = offset;
    this.rows.push({
      line: { value, offset },
      bounds: continued ? cellBounds(content) : bounds,
      continued,
      kind,
      group: this.group,
    });
    this.endOffset = offset + value.length;
    this.phase = kind === "head" ? "headers" : "body";
    return true;
  }

  /** 返回独立模型快照，不关闭识别器；可重复调用或继续 push，内容不会执行或转换成 HTML。 */
  finish(): Table | null {
    if (!this.accepted) return null;
    const rawRows: RawRow[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      const row = this.rows[i]!;
      if (row.continued) {
        let end = i;
        while (
          end < this.rows.length &&
          this.rows[end]!.continued &&
          this.rows[end]!.group === row.group
        )
          end++;
        if (end < this.rows.length && this.rows[end]!.group === row.group) {
          rawRows.push({ ...row, parts: this.rows.slice(i, end + 1) });
          i = end;
          continue;
        }
        // 未闭合的续行串按普通行保留，避免每一行重新扫描同一后缀。
        for (let pending = i; pending < end; pending++)
          rawRows.push(this.rows[pending]!);
        i = end - 1;
        continue;
      }
      rawRows.push(row);
    }
    const sections: Section[] = [];
    let group = -1;
    let above: (Cell | undefined)[] = [];
    for (const raw of rawRows) {
      const last = raw.parts?.at(-1) || raw;
      const row: Row = {
        cells: [],
        range: {
          start: raw.line.offset,
          end: last.line.offset + last.line.value.length,
        },
      };
      if (raw.group !== group) {
        group = raw.group;
        above = [];
        sections.push({ kind: raw.kind, rows: [], range: { ...row.range } });
      }
      let left: Cell | undefined;
      for (let column = 0; column < raw.bounds.length - 1; column++) {
        const start = raw.bounds[column]! + 1,
          end = raw.bounds[column + 1]!;
        const text = raw.line.value.slice(start, end);
        if (text === "") {
          if (left) left.colspan++;
          continue;
        }
        if (this.options.rowspan && above[column] && text.trim() === "^^") {
          above[column]!.rowspan++;
          left = undefined;
          continue;
        }
        const block = !!raw.parts;
        const segments: Range[] = [];
        let value: string;
        if (raw.parts) {
          const values: string[] = [];
          for (const part of raw.parts) {
            if (column >= part.bounds.length - 1) continue;
            const a = part.bounds[column]! + 1;
            const content = part.line.value
              .slice(a, part.bounds[column + 1])
              .trimEnd();
            segments.push({
              start: part.line.offset + a,
              end: part.line.offset + a + content.length,
            });
            values.push(content);
          }
          value = values.join("\n");
        } else {
          // 普通单元格复用已切出的文本，不为单段内容构造临时数组。
          const leading = text.length - text.trimStart().length;
          value = text.trim();
          segments.push({
            start: raw.line.offset + start + leading,
            end: raw.line.offset + start + leading + value.length,
          });
        }
        const cell: Cell = {
          column,
          colspan: 1,
          rowspan: 1,
          align: this.columns![column]?.align || null,
          wrap: this.columns![column]?.wrap || false,
          block,
          value,
          segments,
          range: {
            start: raw.line.offset + start,
            end:
              last.line.offset +
              (last.bounds[column + 1] ?? last.line.value.length),
          },
        };
        row.cells.push(cell);
        left = above[column] = cell;
      }
      sections.at(-1)!.rows.push(row);
      sections.at(-1)!.range.end = row.range.end;
    }
    return {
      type: "multimdTable",
      columns: this.columns!.map((column) => ({ ...column })),
      caption: this.caption
        ? {
            ...this.caption,
            range: { ...this.caption.range },
            contentRange: { ...this.caption.contentRange },
          }
        : null,
      sections,
      range: { start: this.firstOffset, end: this.endOffset },
    };
  }
}

/** 从字符串开头解析一个表格；非表格返回 null，不负责寻找文档中的表格。 */
export function parseTable(
  source: string,
  options: Options = {},
): Table | null {
  const scanner = new TableScanner(options);
  let offset = 0;
  // 只扫描表格及第一条被拒绝的行，避免为无关文档后缀分配整份行数组。
  const newline = /\r\n|\r|\n/g;
  while (offset <= source.length) {
    const match = newline.exec(source);
    const end = match ? match.index : source.length;
    const line = source.slice(offset, end);
    if (!scanner.push(line, offset)) break;
    if (!match || scanner.finished) break;
    offset = newline.lastIndex;
  }
  return scanner.finish();
}

export interface ExpandedCell {
  value: string;
  origin: Cell;
  inherited: boolean;
}
/** 展开只补齐位置关系，不推断合计/分组语义；保留 origin，消费者可避免重复计数。 */
export function expandSection(section: Section): (ExpandedCell | null)[][] {
  const grid: (ExpandedCell | null)[][] = section.rows.map(() => []);
  section.rows.forEach((row, r) =>
    row.cells.forEach((cell) => {
      for (let dr = 0; dr < cell.rowspan && r + dr < grid.length; dr++) {
        for (let dc = 0; dc < cell.colspan; dc++) {
          grid[r + dr]![cell.column + dc] = {
            value: cell.value,
            origin: cell,
            inherited: dr > 0 || dc > 0,
          };
        }
      }
    }),
  );
  let width = 0;
  for (const row of grid) width = Math.max(width, row.length);
  // grid 为本次展开独有，直接补齐空位，避免为矩形结果再次复制每行。
  for (const row of grid)
    for (let col = 0; col < width; col++) row[col] ??= null;
  return grid;
}
