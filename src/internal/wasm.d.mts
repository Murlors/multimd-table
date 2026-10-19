import type { Options, Table, WriteTable, Section, ExpandedCell } from "../types.js";
import type { TableScanner } from "../core.js";

interface Binding {
  readonly defaults: Readonly<Required<Options>>;
  readonly TableScanner: { new(options?: Options): TableScanner; readonly prototype: TableScanner };
  parseTable(source: string, options?: Options): Table | null;
  cellBounds(source: string): number[];
  stringifyTable(table: WriteTable): string;
  disposeScanners(): void;
  activeScanners(): number;
  memoryBytes(): number;
}

/** 私有绑定声明；公共模型的类型不依赖 WebAssembly 或 Node 类型。 */
export function createCore(instance: WebAssembly.Instance, transport?: {
  copyUtf16?: (source: string, buffer: ArrayBuffer, pointer: number) => number;
}): Binding;

export function expandSection(section: Section): (ExpandedCell | null)[][];
