import { Reader, encodeWrite } from "./wire.mjs";
export { encodeWrite };

export const defaults = Object.freeze({
  multiline: false,
  rowspan: false,
  headerless: false,
  multibody: true,
  autolabel: true,
});
export const flags = (options) =>
  (options.multiline ? 1 : 0) |
  (options.rowspan ? 2 : 0) |
  (options.headerless ? 4 : 0) |
  (options.multibody ? 8 : 0) |
  (options.autolabel ? 16 : 0);

/** 绑定只负责 UTF-16/模型搬运；不参与任何表格语法判断。 */
export function createCore(instance, { copyUtf16 } = {}) {
  const api = instance.exports;
  const live = new Set();
  const release = (state) => {
    if (state.pointer) {
      api.mm_scanner_free(state.pointer);
      state.pointer = 0;
      live.delete(state);
    }
    state.disposed = true;
  };
  const finalizers = new FinalizationRegistry(release);
  const withText = (source, call) => {
    if (typeof source !== "string") throw new TypeError("Expected Markdown string");
    const pointer = api.mm_alloc(source.length);
    try {
      if (copyUtf16 && source.length >= 16384) {
        const written = copyUtf16(source, api.memory.buffer, pointer);
        if (written !== source.length * 2) throw new RangeError("Invalid UTF-16 transport length");
      } else {
        const memory = new DataView(api.memory.buffer, pointer, source.length * 2);
        for (let i = 0; i < source.length; i++) memory.setUint16(i * 2, source.charCodeAt(i), true);
      }
      return call(pointer, source.length);
    } finally {
      api.mm_free(pointer, source.length);
    }
  };
  // 借用响应只解码；诊断探针可重复读取，释放时机由探针决定。
  const readBuffer = (pointer, decode) => {
    const reader = new Reader(
      api.memory.buffer,
      api.mm_result_ptr(pointer),
      api.mm_result_len(pointer),
    );
    return reader.complete(decode(reader));
  };
  // 普通调用拥有返回的响应，即使解码失败也必须释放。
  const readResult = (pointer, decode) => {
    try {
      return readBuffer(pointer, decode);
    } finally {
      api.mm_result_free(pointer);
    }
  };
  class TableScanner {
    constructor(options = {}) {
      this.options = { ...defaults, ...options };
      this.state = { pointer: 0, disposed: false };
      this.bits = 0;
      this.position = 0;
      this.remap = false;
      this.optionBits = flags(this.options);
      finalizers.register(this, this.state, this);
      this.parts = [];
    }
    get accepted() {
      return !!(this.bits & 1);
    }
    get committed() {
      return !!(this.bits & 2);
    }
    get finished() {
      return !!(this.bits & 4);
    }
    configure() {
      const bits = flags(this.options);
      if (!this.state.pointer) {
        this.state.pointer = api.mm_scanner_new(bits);
        live.add(this.state);
      } else if (bits !== this.optionBits) api.mm_scanner_options(this.state.pointer, bits);
      this.optionBits = bits;
    }
    push(source, offset) {
      if (this.state.disposed) throw new Error("Scanner is disposed");
      if (this.finished) return false;
      if (typeof source !== "string") throw new TypeError("Expected Markdown string");
      if (
        !Number.isSafeInteger(offset) ||
        offset < 0 ||
        !Number.isSafeInteger(offset + source.length)
      )
        throw new RangeError("Expected a nonnegative safe UTF-16 offset");
      if (this.position + source.length > 0xffffffff)
        throw new RangeError("Table input exceeds the WASM address space");
      this.configure();
      const start = this.position;
      const result = withText(source, (pointer, length) =>
        api.mm_scanner_push(this.state.pointer, pointer, length, start),
      );
      this.bits = result >>> 1;
      if (result & 1) {
        this.parts.push({ source, offset, start });
        this.position += source.length + 1;
        this.remap ||= start !== offset;
      }
      return !!(result & 1);
    }
    finish() {
      if (this.state.disposed) throw new Error("Scanner is disposed");
      if (!this.state.pointer) return null;
      this.configure();
      const parts = this.parts;
      let index = 0;
      // Rust 只看到连续的表内位置；宿主偏移可以有间隔、乱序或超过 32 位。
      const partAt = (position) => {
        if (!parts[index] || position < parts[index].start || parts[index + 1]?.start <= position) {
          let low = 0,
            high = parts.length;
          while (low < high) {
            const middle = (low + high) >>> 1;
            if (parts[middle].start <= position) low = middle + 1;
            else high = middle;
          }
          index = Math.max(0, low - 1);
        }
        const part = parts[index];
        if (!part || position < part.start || position > part.start + part.source.length)
          throw new Error("Invalid source position");
        return part;
      };
      const slice = (start, end) => {
        const part = partAt(start);
        if (end > part.start + part.source.length) throw new Error("Invalid source segment");
        return part.source.slice(start - part.start, end - part.start);
      };
      const table = readResult(api.mm_scanner_finish_compact(this.state.pointer), (reader) =>
        reader.table(slice),
      );
      if (table && this.remap) {
        const translate = (position) => {
          const part = partAt(position);
          return part.offset + (position - part.start);
        };
        const range = (value) => {
          value.start = translate(value.start);
          value.end = translate(value.end);
        };
        range(table.range);
        if (table.caption) {
          range(table.caption.range);
          range(table.caption.contentRange);
        }
        for (const section of table.sections) {
          range(section.range);
          for (const row of section.rows) {
            range(row.range);
            for (const cell of row.cells) {
              range(cell.range);
              for (const segment of cell.segments) range(segment);
            }
          }
        }
      }
      return table;
    }
    dispose() {
      release(this.state);
      this.parts.length = 0;
      finalizers.unregister(this);
    }
  }
  return {
    defaults,
    TableScanner,
    parseTable(source, options = {}) {
      return withText(source, (p, n) =>
        readResult(api.mm_parse_compact(p, n, flags({ ...defaults, ...options })), (reader) =>
          reader.table((start, end) => source.slice(start, end)),
        ),
      );
    },
    cellBounds(source) {
      return withText(source, (p, n) =>
        readResult(api.mm_bounds(p, n), (reader) => reader.bounds()),
      );
    },
    stringifyTable(table) {
      const bytes = encodeWrite(table);
      const pointer = api.mm_alloc(bytes.length / 2);
      try {
        new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
        return readResult(api.mm_write(pointer, bytes.length / 2), (reader) =>
          reader.writeResult(),
        );
      } finally {
        api.mm_free(pointer, bytes.length / 2);
      }
    },
    disposeScanners() {
      for (const state of live) release(state);
    },
    activeScanners() {
      return live.size;
    },
    memoryBytes() {
      return api.memory.buffer.byteLength;
    },
    /** 写回诊断：完整宿主模型、请求和响应均预装载，独立测量各搬运阶段。 */
    profileWrite(table) {
      const bytes = encodeWrite(table),
        pointer = api.mm_alloc(bytes.length / 2);
      new Uint8Array(api.memory.buffer, pointer, bytes.length).set(bytes);
      const model = api.mm_profile_write_new(pointer, bytes.length / 2);
      const wire = api.mm_write(pointer, bytes.length / 2);
      const decode = () => readBuffer(wire, (reader) => reader.writeResult());
      return {
        bytes: api.mm_result_len(wire),
        stages: {
          input: () => encodeWrite(table),
          copy: () => {
            const p = api.mm_alloc(bytes.length / 2);
            new Uint8Array(api.memory.buffer, p, bytes.length).set(bytes);
            api.mm_free(p, bytes.length / 2);
            return p;
          },
          decodeInput: () => {
            const m = api.mm_profile_write_new(pointer, bytes.length / 2);
            api.mm_profile_write_free(m);
            return m;
          },
          rust: () => api.mm_profile_write_core(model),
          rustWire: () => {
            const b = api.mm_write(pointer, bytes.length / 2);
            api.mm_result_free(b);
            return b;
          },
          decode,
          full: () => this.stringifyTable(table),
        },
        dispose() {
          api.mm_result_free(wire);
          api.mm_profile_write_free(model);
          api.mm_free(pointer, bytes.length / 2);
        },
      };
    },
    /** 仅用于实验诊断。预装载资源在 dispose 前一直有效，返回值须逃逸到计时循环外。 */
    profile(source, options = {}) {
      const bits = flags({ ...defaults, ...options });
      const pointer = api.mm_alloc(source.length);
      const copy = () => {
        const units = new DataView(api.memory.buffer, pointer, source.length * 2);
        for (let i = 0; i < source.length; i++) units.setUint16(i * 2, source.charCodeAt(i), true);
      };
      copy();
      const scanner = api.mm_profile_scan(pointer, source.length, bits);
      const model = api.mm_profile_finish(scanner);
      const wire = api.mm_profile_encode(model);
      // 编码缓冲区稳定，但 memory.grow 可替换 ArrayBuffer；每次解码重新取得视图。
      const decode = () =>
        readBuffer(wire, (reader) => reader.table((start, end) => source.slice(start, end)));
      return {
        bytes: api.mm_result_len(wire),
        stages: {
          input: () => withText(source, () => source.length),
          scan: () => {
            const s = api.mm_profile_scan(pointer, source.length, bits);
            api.mm_scanner_free(s);
            return s;
          },
          model: () => {
            const m = api.mm_profile_finish(scanner);
            api.mm_profile_model_free(m);
            return m;
          },
          encode: () => {
            const b = api.mm_profile_encode(model);
            api.mm_result_free(b);
            return b;
          },
          rust: () => {
            const s = api.mm_profile_scan(pointer, source.length, bits);
            const m = api.mm_profile_finish(s);
            api.mm_profile_model_free(m);
            api.mm_scanner_free(s);
            return m;
          },
          rustWire: () => {
            const b = api.mm_parse_compact(pointer, source.length, bits);
            api.mm_result_free(b);
            return b;
          },
          decode,
          full: () =>
            withText(source, (p, n) =>
              readResult(api.mm_parse_compact(p, n, bits), (reader) =>
                reader.table((start, end) => source.slice(start, end)),
              ),
            ),
        },
        dispose() {
          api.mm_result_free(wire);
          api.mm_profile_model_free(model);
          api.mm_scanner_free(scanner);
          api.mm_free(pointer, source.length);
        },
      };
    },
  };
}

// 仅展开宿主已有的模型，不执行解析；保留 origin 的 JS 对象身份。
export function expandSection(section) {
  const width = section.rows.reduce(
    (width, row) =>
      row.cells.reduce((width, cell) => Math.max(width, cell.column + cell.colspan), width),
    0,
  );
  const grid = section.rows.map(() => Array(width).fill(null));
  section.rows.forEach((row, r) => {
    for (const cell of row.cells)
      for (let down = 0; down < cell.rowspan && r + down < grid.length; down++)
        for (let right = 0; right < cell.colspan; right++)
          grid[r + down][cell.column + right] = {
            value: cell.value,
            origin: cell,
            inherited: down > 0 || right > 0,
          };
  });
  return grid;
}
