const alignments = [null, "left", "center", "right"];
const TABLE_FORMAT = 1;
// decode 不使用 stream，每次调用独立；严格解码失败后仍可安全复用。
const utf16 = new TextDecoder("utf-16le", { fatal: true, ignoreBOM: true });

/** 只读取借用的协议字节并构建完整模型；缓冲区的释放由调用方负责。 */
export class Reader {
  constructor(buffer, pointer, length) {
    this.view = new DataView(buffer, pointer, length);
    this.offset = 0;
  }

  number() {
    const value = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return value;
  }

  text() {
    const length = this.number();
    if (length > (this.view.byteLength - this.offset) / 2)
      throw new RangeError("Truncated response text");
    if (length >= 64) {
      const bytes = new Uint8Array(
        this.view.buffer,
        this.view.byteOffset + this.offset,
        length * 2,
      );
      try {
        const value = utf16.decode(bytes);
        this.offset += length * 2;
        return value;
      } catch {
        // 孤立代理字符必须按 UTF-16 单元恢复，不能替换成 U+FFFD。
      }
    }
    const units = new Uint16Array(length);
    for (let i = 0; i < length; i++) {
      units[i] = this.view.getUint16(this.offset, true);
      this.offset += 2;
    }
    let value = "";
    for (let i = 0; i < length; i += 8192)
      value += String.fromCharCode(...units.subarray(i, i + 8192));
    return value;
  }

  bounds() {
    const bounds = Array(this.number());
    for (let i = 0; i < bounds.length; i++) bounds[i] = this.number() | 0;
    return bounds;
  }
  range() {
    return { start: this.number(), end: this.number() };
  }

  /** 协议按表、分区、行、单元格顺序读取；slice 只提供 UTF-16 坐标对应的原文。 */
  table(slice) {
    const format = this.number();
    if (!format) return null;
    if (format !== TABLE_FORMAT) throw new Error("Unsupported compact table format");
    // 协议长度为无符号整数；按长度预分配后填充，避免热路径重复扩容。
    const columns = Array(this.number());
    for (let i = 0; i < columns.length; i++)
      columns[i] = { align: alignments[this.number()], wrap: !!this.number() };
    let caption = null;
    if (this.number()) {
      const id = this.number() ? this.text() : null,
        side = this.number() ? "bottom" : "top";
      const range = this.range(),
        contentRange = this.range();
      caption = {
        value: slice(contentRange.start, contentRange.end),
        id,
        side,
        range,
        contentRange,
      };
    }
    const sections = Array(this.number());
    for (let s = 0; s < sections.length; s++) {
      const kind = this.number() ? "body" : "head",
        range = this.range(),
        rows = Array(this.number());
      for (let r = 0; r < rows.length; r++) {
        const range = this.range(),
          cells = Array(this.number());
        for (let c = 0; c < cells.length; c++) {
          const column = this.number(),
            colspan = this.number(),
            rowspan = this.number(),
            block = !!this.number();
          const range = this.range(),
            count = this.number();
          let segments, value;
          if (count === 1) {
            const segment = this.range();
            segments = [segment];
            value = slice(segment.start, segment.end);
          } else {
            segments = Array(count);
            value = "";
            for (let part = 0; part < count; part++) {
              const segment = this.range();
              segments[part] = segment;
              if (part) value += "\n";
              value += slice(segment.start, segment.end);
            }
          }
          cells[c] = {
            column,
            colspan,
            rowspan,
            align: columns[column]?.align ?? null,
            wrap: columns[column]?.wrap ?? false,
            block,
            range,
            segments,
            value,
          };
        }
        rows[r] = { range, cells };
      }
      sections[s] = { kind, range, rows };
    }
    return { type: "multimdTable", columns, caption, sections, range: this.range() };
  }

  writeResult() {
    const failed = this.number(),
      value = this.text();
    if (failed) throw new RangeError(value);
    return value;
  }

  complete(value) {
    if (this.offset !== this.view.byteLength) throw new Error("Trailing response bytes");
    return value;
  }
}

/** Writer 输入协议对缺省值与显式 null 分别编码；数值不能静默截断。 */
export function encodeWrite(table) {
  let bytes = new Uint8Array(1024),
    view = new DataView(bytes.buffer),
    offset = 0;
  const reserve = (n) => {
    if (offset + n <= bytes.length) return;
    const next = new Uint8Array(Math.max(bytes.length * 2, offset + n));
    next.set(bytes);
    bytes = next;
    view = new DataView(bytes.buffer);
  };
  const number = (n) => {
    if (!Number.isInteger(n) || n < 0 || n > 0xffffffff)
      throw new RangeError("Invalid or out-of-range writer number");
    reserve(4);
    view.setUint32(offset, n, true);
    offset += 4;
  };
  const text = (value) => {
    if (typeof value !== "string")
      throw new RangeError("Cell and caption values must be Markdown strings");
    number(value.length);
    reserve(value.length * 2);
    for (let i = 0; i < value.length; i++) {
      view.setUint16(offset, value.charCodeAt(i), true);
      offset += 2;
    }
  };
  number(table.columns.length);
  for (const column of table.columns) {
    const align = alignments.indexOf(column.align);
    if (align < 0) throw new RangeError("Invalid alignment");
    number(align);
    number(+!!column.wrap);
  }
  number(table.sections.length);
  for (const section of table.sections) {
    if (!["head", "body"].includes(section.kind)) throw new RangeError("Invalid section kind");
    number(section.kind === "head" ? 0 : 1);
    number(section.rows.length);
    for (const row of section.rows) {
      number(row.cells.length);
      for (const cell of row.cells) {
        number(cell.column);
        number(cell.colspan ?? 1);
        number(cell.rowspan ?? 1);
        number(+!!cell.block);
        text(cell.value);
      }
    }
  }
  number(+!!table.caption);
  if (table.caption) {
    const caption = table.caption;
    text(caption.value);
    number(caption.id === undefined ? 0 : caption.id === null ? 1 : 2);
    if (caption.id !== undefined && caption.id !== null) text(caption.id);
    if (!["top", "bottom"].includes(caption.side)) throw new RangeError("Invalid caption side");
    number(caption.side === "bottom" ? 1 : 0);
  }
  return bytes.slice(0, offset);
}
