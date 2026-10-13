import { cellBounds, type Alignment } from "./core.js";

/** 写出模型无需源文位置；宿主先把单元格内容序列化为 Markdown。 */
export interface WriteCell {
  column: number;
  colspan?: number;
  rowspan?: number;
  value: string;
  block?: boolean;
}
export interface WriteRow { cells: readonly WriteCell[] }
export interface WriteSection {
  kind: "head" | "body";
  rows: readonly WriteRow[];
}
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

type Origin = { cell: WriteCell; row: number; column: number; colspan: number };

function invalid(message: string): never {
  throw new RangeError(`Cannot stringify MultiMarkdown table: ${message}`);
}

/** 只构建一次占位网格，跨度填充成本与实际覆盖面积一致。 */
function grid(section: WriteSection, width: number, index: number): Origin[][] {
  if (!section.rows.length) invalid(`section ${index} has no rows`);
  const slots: (Origin | undefined)[][] = Array.from(
    { length: section.rows.length }, () => Array(width),
  );
  section.rows.forEach((row, r) => {
    for (const cell of row.cells) {
      const colspan = cell.colspan ?? 1, rowspan = cell.rowspan ?? 1;
      if (!Number.isSafeInteger(cell.column) || cell.column < 0 ||
          !Number.isSafeInteger(colspan) || colspan < 1 ||
          !Number.isSafeInteger(rowspan) || rowspan < 1)
        invalid(`section ${index}, row ${r}: column and spans must be positive integers (column may be zero)`);
      if (cell.column + colspan > width || r + rowspan > slots.length)
        invalid(`section ${index}, row ${r}, column ${cell.column}: span exceeds its section or columns`);
      if (typeof cell.value !== "string") invalid(`section ${index}, row ${r}: cell value must be Markdown text`);
      const origin = { cell, row: r, column: cell.column, colspan };
      for (let dr = 0; dr < rowspan; dr++) {
        for (let dc = 0; dc < colspan; dc++) {
          const column = cell.column + dc;
          if (slots[r + dr]![column]) invalid(`section ${index}, row ${r + dr}, column ${column}: overlapping spans`);
          slots[r + dr]![column] = origin;
        }
      }
    }
  });
  for (let r = 0; r < slots.length; r++)
    for (let c = 0; c < width; c++)
      if (!slots[r]![c]) invalid(`section ${index}, row ${r}, column ${c}: uncovered position; use an explicit empty cell`);
  return slots as Origin[][];
}

/**
 * 按 Markdown 的反引号串配对处理代码，其余管道转义。
 * 预先索引下一个同长度反引号串，避免未闭合串反复扫描后缀。
 */
function inline(value: string): string {
  const runs = [...value.matchAll(/`+/g)];
  const next = new Map<number, number>(), last = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const run = runs[i]!;
    const closing = last.get(run[0].length);
    if (closing !== undefined) next.set(run.index, closing);
    last.set(run[0].length, run.index);
  }
  const tag = /<\/?([A-Za-z][A-Za-z0-9-]*)(?:\s+[A-Za-z_:][A-Za-z0-9_.:-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*\s*\/?>/gy;
  const rawClosing = /<\/(?:code|pre|script|style|textarea)\s*>/gi;
  const autolink = /<(?:[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\u0000-\u0020<>]*|[^<>\s]*@[^<>\s]+)>/gy;
  const parts: string[] = [];
  for (let i = 0; i < value.length;) {
    if (value[i] === "<") {
      tag.lastIndex = i;
      const match = tag.exec(value);
      if (match) {
        // HTML 属性内反斜杠不是 Markdown 转义，改用 HTML 实体保留管道含义。
        parts.push(match[0].replace(/\|/g, "&#124;"));
        i = tag.lastIndex;
        if (!match[0].startsWith("</") && /^(?:code|pre|script|style|textarea)$/i.test(match[1]!) && !match[0].endsWith("/>")) {
          rawClosing.lastIndex = i;
          let closing: RegExpExecArray | null;
          while ((closing = rawClosing.exec(value)) && !new RegExp(`^</${match[1]}\\s*>$`, "i").test(closing[0])) {}
          const end = closing ? rawClosing.lastIndex : value.length;
          const raw = value.slice(i, end);
          if (/[ \t]+\n/.test(raw)) invalid("trailing whitespace in raw HTML content is not preserved by MultiMarkdown tables");
          // code/pre/textarea 会解码实体；script/style 则必须原样保留。
          parts.push(/^(?:code|pre|textarea)$/i.test(match[1]!)
            ? raw.replace(/[|`]/g, (char) => char === "|" ? "&#124;" : "&#96;")
            : raw);
          i = end;
        }
        continue;
      }
      autolink.lastIndex = i;
      const link = autolink.exec(value);
      if (link) {
        if (link[0].includes("|")) invalid("autolink containing pipes must be serialized as an explicit Markdown link by the host");
        parts.push(link[0]);
        i = autolink.lastIndex;
        continue;
      }
    }
    if (value[i] === " ") {
      let end = i + 1;
      while (value[end] === " ") end++;
      if (end - i >= 2 && value[end] === "\n") {
        parts.push("\\");
        i = end;
        continue;
      }
      parts.push(value.slice(i, end));
      i = end;
      continue;
    }
    if (value[i] === "\\") {
      let end = i + 1;
      while (value[end] === "\\") end++;
      const count = end - i;
      // core 的转义扫描不区分奇偶；实体保留偶数反斜杠的 Markdown 含义。
      if (value[end] === "|" || value[end] === "`") {
        parts.push("&#92;".repeat(Math.floor(count / 2)));
        if (count % 2) {
          parts.push("\\", value[end]!);
          i = end + 1;
          continue;
        }
      } else parts.push(value.slice(i, end));
      i = end;
      continue;
    }
    if (value[i] === "`") {
      let end = i + 1;
      while (value[end] === "`") end++;
      const closing = next.get(i);
      if (closing === undefined) {
        parts.push("\\`".repeat(end - i));
        i = end;
        continue;
      }
      const content = value.slice(end, closing).replace(/\n/g, " ");
      let marker = value.slice(i, end);
      if (content.includes("|") && marker.length > 1) {
        if (content.includes("`")) invalid("code span containing pipes and backticks cannot be represented by the table delimiter syntax");
        marker = "`";
      }
      parts.push(marker, content, marker);
      i = closing + end - i;
      continue;
    }
    parts.push(value[i] === "|" ? "\\|" : value[i]!);
    i++;
  }
  return parts.join("");
}

/** 块级代码必须原样保留；无法安全穿过表格分隔符时显式拒绝。 */
function content(cell: WriteCell): string[] {
  const value = cell.value.replace(/\r\n?|\n/g, "\n");
  if (!cell.block) return inline(value).split("\n");
  const lines = value.split("\n"), output: string[] = [];
  let fence: { marker: string; length: number } | undefined;
  let prose: string[] = [];
  const flush = () => {
    if (prose.length) output.push(...inline(prose.join("\n")).split("\n"));
    prose = [];
  };
  for (const line of lines) {
    // 引用和列表容器内的围栏同样属于原样保留的代码。
    const candidate = line.replace(/^\s*(?:>\s*)+/, "")
      .replace(/^\s*(?:[-+*]|\d+[.)])\s+/, "");
    const opening = /^\s*(`{3,}|~{3,})(.*)$/.exec(candidate);
    const code = !!fence || !!opening || /^(?: {4}|\t)/.test(line);
    if (code) {
      flush();
      if (cellBounds(`|${line} |`).length !== 2)
        invalid("pipe or backtick in block code cannot be represented without changing its content");
      if (/\s$/.test(line)) invalid("trailing whitespace in block code is not preserved by MultiMarkdown tables");
      output.push(line);
      if (fence) {
        const closing = /^\s*(`+|~+)\s*$/.exec(candidate);
        if (closing && closing[1]![0] === fence.marker && closing[1]!.length >= fence.length) fence = undefined;
      } else if (opening) fence = { marker: opening[1]![0]!, length: opening[1]!.length };
    } else {
      prose.push(line);
    }
  }
  flush();
  return output;
}

function caption(caption: WriteCaption): string {
  if (caption.side !== "top" && caption.side !== "bottom") invalid("caption side must be top or bottom");
  if (typeof caption.value !== "string" || !caption.value.trim() || /[\r\n]/.test(caption.value))
    invalid("caption must contain nonempty single-line Markdown");
  const automatic = caption.value.toLowerCase().replace(/\W+/g, "");
  let label = "";
  if (caption.id !== undefined && caption.id !== null && caption.id !== automatic) {
    if (!/^[a-z0-9_]*$/.test(caption.id)) invalid("caption ID must be the normalized ID understood by the parser");
    // 非词字符标签会规范化为空 ID，仍能表达英文标题的显式空 ID。
    label = `[${caption.id || "!"}]`;
  }
  const source = `[${caption.value}]${label}`;
  const parsed = /^\s*\[(.+?)\](\[([^\[\]]+)\])?\s*$/.exec(source);
  if (!parsed || parsed[1] !== caption.value ||
      (label && parsed[3]!.toLowerCase().replace(/\W+/g, "") !== caption.id))
    invalid("caption Markdown is ambiguous with an explicit label");
  return source;
}

/**
 * 写出规范表格（无尾换行），保留结构和 Markdown 语义而非源文空白。
 * 无效网格或无法无损表示的内容抛出 RangeError；不会裁剪跨度或补造空单元格。
 * 读取完整语法时启用 rowspan、multiline、headerless 和 multibody。
 */
export function stringifyTable(table: WriteTable): string {
  const width = table.columns.length;
  if (!width) invalid("at least one column is required");
  if (!table.sections.length) invalid("at least one nonempty section is required");
  const delimiter = "|" + table.columns.map((column) => {
    if (![null, "left", "center", "right"].includes(column.align)) invalid("invalid column alignment");
    return `${column.align === "left" || column.align === "center" ? ":" : ""}---${column.align === "right" || column.align === "center" ? ":" : ""}${column.wrap ? "+" : ""}`;
  }).join("|") + "|";
  const output: string[] = [];
  if (table.caption?.side === "top") output.push(caption(table.caption));
  let separated = false;
  table.sections.forEach((section, sectionIndex) => {
    if (section.kind !== "head" && section.kind !== "body") invalid(`section ${sectionIndex}: invalid kind`);
    if (section.kind === "head" && sectionIndex !== 0) invalid("a single head section must precede all bodies");
    if (section.kind === "body") {
      if (!separated) { output.push(delimiter); separated = true; }
      else output.push("");
    }
    const slots = grid(section, width, sectionIndex);
    section.rows.forEach((row, r) => {
      const values = new Map<WriteCell, string[]>();
      let count = 1, block = false;
      for (const cell of row.cells) {
        const lines = content(cell);
        values.set(cell, lines);
        count = Math.max(count, lines.length);
        block ||= !!cell.block || lines.length > 1;
      }
      if (block) count = Math.max(count, 2);
      const physical: string[] = [];
      for (let line = 0; line < count; line++) {
        const columns: string[] = [];
        for (let c = 0; c < width; c++) {
          const origin = slots[r]![c]!;
          if (c !== origin.column) { columns.push(""); continue; }
          if (origin.row !== r) { columns.push(line === 0 ? " ^^ " : " "); continue; }
          let text = values.get(origin.cell)![line] ?? "";
          if (line === 0 && text.trim() === "^^") text = text.replace("^^", "\\^^");
          if (block && !origin.cell.block && values.get(origin.cell)!.length === 1) {
            // 行级续行会把内联兄弟提升为块；保护其原本只是文字的块标记。
            // 首个空白改写为实体，保留文字缩进，同时阻止它触发块缩进或被块解析器删除。
            if (/^[ \t]/.test(text) && text.trim())
              text = (text[0] === "\t" ? "&#9;" : "&#32;") + text.slice(1);
            if (/^ {0,3}(?:#{1,6}(?:\s|$)|>|[-+*]\s|\d{1,9}[.)]\s)/.test(text) ||
                /^ {0,3}(?:(?:\*\s*){3,}|(?:-\s*){3,}|(?:_\s*){3,})$/.test(text))
              text = text.replace(/^([ ]{0,3})([#>+*_-]|\d+[.)])/, (_, indent: string, marker: string) =>
                indent + (marker.length === 1 ? `\\${marker}` : marker.slice(0, -1) + "\\" + marker.slice(-1)));
            if (/^ {0,3}(?:<(?:!--|!|\?|\/?(?:address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)\b)|\[[^\]]+\]:)/i.test(text))
              invalid("inline HTML block or reference definition cannot be promoted to a multiline block row without changing semantics");
          }
          // 防止分隔行候选吞掉表头；块级内容另加空续行，保留块语义。
          if (!block && /^:?(-+|=+):?\+?$/.test(text.trim())) text = text.replace(/[-=:]/, (char) => `\\${char}`);
          columns.push(block ? `${text} ` : ` ${text} `);
        }
        const source = "|" + columns.join("|") + "|";
        if (cellBounds(source).length !== width + 1) invalid(`section ${sectionIndex}, row ${r}: cell Markdown hides a table delimiter`);
        physical.push(source);
      }
      if (block && physical[0]!.split("|").slice(1, -1).every((text) => /^\s*:?(-+|=+):?\+?\s*$/.test(text)))
        physical.unshift("|" + Array.from({ length: width }, (_, c) => c === slots[r]![c]!.column ? " " : "").join("|") + "|");
      output.push(...physical.map((line, index) => line + (index < physical.length - 1 ? "\\" : "")));
    });
  });
  if (!separated) output.push(delimiter);
  if (table.caption) {
    const source = caption(table.caption);
    if (table.caption.side === "bottom") output.push(source);
  }
  return output.join("\n");
}
