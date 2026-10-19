import { fromMarkdown } from "mdast-util-from-markdown";
import type {
  Extension as MdastExtension,
  Options as FromMarkdownOptions,
} from "mdast-util-from-markdown";
import type {
  Construct,
  Extension,
  Point,
  ParseContext,
  State,
  Token,
  Tokenizer,
} from "micromark-util-types";
import type { Root, RootContent, PhrasingContent, Data } from "mdast";
import type { Parent, Position } from "unist";
import type { Plugin } from "unified";
import type { Options, Table, Range } from "./core.js";
import { cellBounds, TableScanner } from "./core.js";

interface TableToken extends Token {
  table?: Table;
  lineStarts?: Point[];
}
export interface MultimdNode extends Parent {
  type:
    | "multimdTable"
    | "multimdSection"
    | "multimdRow"
    | "multimdCell"
    | "multimdCaption";
  children: (RootContent | PhrasingContent | MultimdNode)[];
  data?: Data;
  model?: Table;
}
interface PendingTableNode extends MultimdNode {
  sourceLineStarts?: Point[];
}
declare module "mdast" {
  interface BlockContentMap {
    multimdTable: MultimdNode;
  }
  interface RootContentMap {
    multimdTable: MultimdNode;
  }
}
declare module "unified" {
  interface Data {
    micromarkExtensions?: Extension[];
    fromMarkdownExtensions?: (MdastExtension | MdastExtension[])[];
  }
}
declare module "micromark-util-types" {
  interface TokenTypeMap {
    multimdTable: "multimdTable";
    multimdLine: "multimdLine";
    multimdInline: "multimdInline";
    multimdSentinel: "multimdSentinel";
  }
}

const isEol = (code: number | null) =>
  code === -3 || code === -4 || code === -5;
export type RemarkOptions = Options;

/** 原生 flow 扩展：只消费经过核心识别器接受的行，失败时交回宿主解析器。 */
function multimdSyntax(
  options: RemarkOptions,
  getSource: () => string | undefined,
  initialize: (parser: ParseContext) => void,
  track: (scanner: TableScanner) => () => void,
): Extension {
  const failedHeaders = new WeakMap<object, Set<number>>();
  const tokenize: Tokenizer = function (effects, ok, nok) {
    const context = this;
    initialize(context.parser);
    const source = getSource();
    const failed = failedHeaders.get(context.parser) || new Set<number>();
    failedHeaders.set(context.parser, failed);
    if (failed.has(context.now().offset)) return nok;
    const scanner = new TableScanner(options);
    const release = track(scanner);
    const lineStarts: Point[] = [];
    let table: TableToken;
    let concrete = false;
    const line: Construct = {
      partial: true,
      tokenize(effects, yes, no) {
        let token: Token;
        return start;
        function start(code: number | null): State | undefined {
          // 空行仍须交给 scanner 判断分段，但 micromark 禁止创建空 token。
          if (code === null || isEol(code))
            return accept("", context.now(), code);
          token = effects.enter("multimdLine");
          return consume(code);
        }
        function consume(code: number | null): State | undefined {
          if (code === null || isEol(code)) {
            effects.exit("multimdLine");
            return accept(context.sliceSerialize(token), token.start, code);
          }
          effects.consume(code);
          return consume;
        }
        function accept(value: string, point: Point, code: number | null) {
          if (context.parser.lazy[point.line]) return no(code);
          if (!scanner.push(value, point.offset)) return no(code);
          lineStarts.push({ ...point });
          return yes(code);
        }
      },
    };
    const continuation: Construct = {
      partial: true,
      tokenize(effects, yes, no) {
        return (code) => {
          if (!isEol(code)) return no(code);
          effects.enter("lineEnding");
          effects.consume(code);
          effects.exit("lineEnding");
          return effects.attempt(line, yes, no);
        };
      },
    };
    return start;
    function start(code: number | null): State | undefined {
      table = effects.enter("multimdTable") as TableToken;
      return effects.attempt(line, afterLine, fail)(code);
    }
    function afterLine(code: number | null): State | undefined {
      // document 在 flow 收到下一行之前决定是否识别容器，须提前释放非表格行。
      // 使用核心边界规则保留表内列表/引用字面值；每个后继物理行只向前扫描一次。
      let nextConcrete = scanner.committed;
      if (nextConcrete && source !== undefined) {
        let start = context.now().offset;
        if (source[start] === "\r") start++;
        if (source[start] === "\n") start++;
        let end = start;
        while (
          end < source.length &&
          source[end] !== "\r" &&
          source[end] !== "\n"
        ) end++;
        nextConcrete = cellBounds(source.slice(start, end)).length >= 2;
      }
      if (concrete !== nextConcrete) {
        concrete = nextConcrete;
        context.currentConstruct = { ...construct, concrete };
      }
      if (scanner.finished || code === null) return finish(code);
      return effects.attempt(continuation, afterLine, finish)(code);
    }
    function finish(code: number | null): State | undefined {
      let model: Table | null;
      try { model = scanner.finish(); } finally { release(); }
      if (!model) return fail(code);
      table.table = model;
      table.lineStarts = lineStarts;
      effects.exit("multimdTable");
      return ok(code);
    }
    function fail(code: number | null): State | undefined {
      // 无分隔行的连续管道文本，其后缀也不可能成为表格；避免逐行重复试探整段。
      if (!scanner.committed)
        for (const point of lineStarts) failed.add(point.offset);
      release();
      return nok(code);
    }
  };
  const construct: Construct = { name: "multimdTable", tokenize };
  // flowInitial 保留四空格表头；flow 允许表格中断已有段落。
  return {
    flowInitial: { null: construct, 32: construct, [-2]: construct },
    flow: { null: construct },
  };
}

interface References {
  links: string[];
  footnotes: string[];
}
interface ParseState extends References {
  depth: number;
  hasTableDefinitions: boolean;
}

/** 只重试表内新增的定义标识；URL、内容与重复定义优先级仍由原生 AST 决定。 */
function tableReferenceSeeds(tree: Root): References {
  const outer = { links: new Set<string>(), footnotes: new Set<string>() };
  const inner = { links: new Set<string>(), footnotes: new Set<string>() };
  function collect(node: any, inTable: boolean) {
    const scope = inTable ? inner : outer;
    if (node.type === "definition") scope.links.add(node.identifier.toUpperCase());
    if (node.type === "footnoteDefinition")
      scope.footnotes.add(node.identifier.toUpperCase());
    for (const child of node.children || [])
      collect(child, inTable || node.type === "multimdTable");
  }
  collect(tree, false);
  return {
    links: [...inner.links].filter((identifier) => !outer.links.has(identifier)),
    footnotes: [...inner.footnotes].filter((identifier) => !outer.footnotes.has(identifier)),
  };
}

/** 子解析器共享宿主文档的引用标识；普通链接与 GFM 脚注使用独立命名空间。 */
function initializeReferences(references: References) {
  const initialized = new WeakSet<object>();
  return (parser: ParseContext & { gfmFootnotes?: string[] }) => {
    if (initialized.has(parser)) return;
    initialized.add(parser);
    for (const identifier of references.links) parser.defined.push(identifier);
    if (references.footnotes.length) {
      const footnotes = (parser.gfmFootnotes ||= []);
      for (const identifier of references.footnotes) footnotes.push(identifier);
    }
  };
}

/** 单元格是内联语法容器，不能将开头的 '-'、'#' 等误当成块。 */
function inlineSyntax(references: References): Extension {
  const initialize = initializeReferences(references);
  const tokenize: Tokenizer = function (effects, ok) {
    // 批量内联解析会为每个单元格启动 tokenizer，定义只能注入一次。
    initialize(this.parser);
    return start;
    function start(code: number | null): State | undefined {
      if (code === null) return ok(code);
      effects.enter("multimdInline");
      // 每行前缀只用于保留空单元格，且阻止列表等外层块语法抢先解析。
      effects.enter("multimdSentinel");
      effects.consume(code);
      effects.exit("multimdSentinel");
      return content;
    }
    function content(code: number | null): State | undefined {
      if (code === null || isEol(code)) {
        effects.exit("multimdInline");
        return ok(code);
      }
      effects.enter("chunkText", { contentType: "text" });
      return consume(code);
    }
    function consume(code: number | null): State | undefined {
      if (code === null || isEol(code)) {
        effects.exit("chunkText");
        effects.exit("multimdInline");
        return ok(code);
      }
      effects.consume(code);
      return consume;
    }
  };
  return {
    disable: { null: ["list", "blockQuote"] },
    flowInitial: { null: { tokenize }, 32: { tokenize }, [-2]: { tokenize } },
  };
}
function definitionSyntax(references: References): Extension {
  const initialize = initializeReferences(references);
  return {
    flowInitial: {
      null: {
        tokenize(_effects, _ok, nok) {
          // flowInitial 可对同一块反复试探，避免定义集合随行数重复膨胀。
          initialize(this.parser);
          return nok;
        },
      },
    },
  };
}

/** 将核心结果接到 mdast；单元格内容仍采用宿主的 Markdown 扩展。 */
function multimdFromMarkdown(
  getExtensions: () => {
    syntax: Extension[];
    mdast: (MdastExtension | MdastExtension[])[];
  },
  withSource: <T>(source: string, parse: () => T) => T,
  state: ParseState,
): MdastExtension {
  return {
    enter: {
      multimdTable(token) {
        const typed = token as TableToken;
        const node: PendingTableNode = {
          type: "multimdTable",
          children: [],
          model: typed.table!,
          sourceLineStarts: typed.lineStarts!,
          data: { hName: "table" },
        };
        this.enter(node, token);
      },
    },
    exit: {
      multimdTable(token) {
        this.exit(token);
      },
    },
    transforms: [
      (tree) => {
        const references: References = {
          links: [...state.links],
          footnotes: [...state.footnotes],
        };
        const tables: PendingTableNode[] = [];
        function collect(node: any) {
          if (node.type === "multimdTable" && node.sourceLineStarts)
            tables.push(node);
          if (node.type === "definition")
            references.links.push(node.identifier.toUpperCase());
          if (node.type === "footnoteDefinition")
            references.footnotes.push(node.identifier.toUpperCase());
          if (state.depth > 1 && (node.type === "definition" || node.type === "footnoteDefinition"))
            state.hasTableDefinitions = true;
          for (const child of node.children || []) collect(child);
        }
        collect(tree);
        for (const node of tables) {
          hydrate(node, references, getExtensions(), withSource);
        }
      },
    ],
  };
}

function hydrate(
  node: PendingTableNode,
  references: References,
  extensions: {
    syntax: Extension[];
    mdast: (MdastExtension | MdastExtension[])[];
  },
  withSource: <T>(source: string, parse: () => T) => T,
) {
  const model = node.model!,
    lineStarts = node.sourceLineStarts!;
  const point = (offset: number) => {
    let lo = 0,
      hi = lineStarts.length;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (lineStarts[mid]!.offset <= offset) lo = mid;
      else hi = mid;
    }
    const start = lineStarts[lo]!;
    return {
      line: start.line,
      column: start.column + offset - start.offset,
      offset,
    };
  };
  const position = (range: Range): Position => ({
    start: point(range.start),
    end: point(range.end),
  });
  const pending: {
    value: string;
    segments: Range[];
    children: RootContent[];
  }[] = [];
  let blockOptions: FromMarkdownOptions | undefined;
  function contents(value: string, block: boolean, segments: Range[]) {
    if (!block) {
      const children: RootContent[] = [];
      pending.push({ value, segments, children });
      return children;
    }
    // 同一表的引用集合固定；复用扩展配置，空集合不增加逐行试探的初始化器。
    blockOptions ||= {
      extensions: references.links.length || references.footnotes.length
        ? [...extensions.syntax, definitionSyntax(references)]
        : extensions.syntax,
      mdastExtensions: extensions.mdast,
    };
    const parsed = withSource(value, () =>
      fromMarkdown(value, blockOptions),
    );
    // 子解析器使用局部坐标；逐段映射回原始文档，跨行单元格不会丢失引用位置。
    function remap(child: any) {
      if (child.position) {
        for (const key of ["start", "end"] as const) {
          const p = child.position[key];
          const segment = segments[Math.min(p.line - 1, segments.length - 1)];
          if (segment)
            child.position[key] = point(
              Math.min(segment.end, segment.start + p.column - 1),
            );
        }
      }
      for (const next of child.children || []) remap(next);
    }
    parsed.children.forEach(remap);
    return parsed.children;
  }
  const children: MultimdNode[] = [];
  if (model.caption) {
    const cap = model.caption;
    children.push({
      type: "multimdCaption",
      position: position(cap.range),
      data: {
        hName: "caption",
        hProperties: {
          ...(cap.id !== null ? { id: cap.id } : {}),
          ...(cap.side === "bottom" ? { style: "caption-side: bottom" } : {}),
        },
      },
      children: contents(cap.value, false, [cap.contentRange]),
    });
  }
  for (const section of model.sections) {
    children.push({
      type: "multimdSection",
      position: position(section.range),
      data: { hName: section.kind === "head" ? "thead" : "tbody" },
      children: section.rows.map((row) => ({
        type: "multimdRow",
        position: position(row.range),
        data: { hName: "tr" },
        children: row.cells.map((cell) => ({
          type: "multimdCell",
          position: position(cell.range),
          data: {
            hName: section.kind === "head" ? "th" : "td",
            hProperties: {
              ...(cell.colspan > 1 ? { colSpan: cell.colspan } : {}),
              ...(cell.rowspan > 1 ? { rowSpan: cell.rowspan } : {}),
              ...(cell.align ? { style: `text-align:${cell.align}` } : {}),
              ...(cell.wrap ? { className: ["extend"] } : {}),
            },
          },
          children: contents(cell.value, cell.block, cell.segments),
        })),
      })),
    });
  }
  node.children = children;
  if (pending.length) {
    const inlineNodes: MdastExtension = {
      enter: {
        multimdInline(token) {
          this.enter({ type: "paragraph", children: [] }, token);
        },
      },
      exit: {
        multimdInline(token) {
          this.exit(token);
        },
      },
    };
    const value = pending.map((item) => "x" + item.value).join("\n");
    const parsed = withSource(value, () =>
      fromMarkdown(value, {
        extensions: [...extensions.syntax, inlineSyntax(references)],
        mdastExtensions: [...extensions.mdast, inlineNodes],
      }),
    );
    parsed.children.forEach((paragraph: any, index) => {
      const item = pending[index]!;
      function remap(child: any) {
        if (child.position)
          for (const key of ["start", "end"] as const) {
            const p = child.position[key];
            child.position[key] = point(
              Math.min(
                item.segments[0]!.end,
                item.segments[0]!.start + p.column - 2,
              ),
            );
          }
        for (const next of child.children || []) remap(next);
      }
      for (const child of paragraph.children || []) {
        remap(child);
        item.children.push(child);
      }
    });
  }
  delete node.sourceLineStarts;
}

/** 安装到 remark-parse；放在 remark-gfm 之后，使扩展表格拥有语法优先级。 */
const remarkMultimdTable: Plugin<[RemarkOptions?], Root> =
  function (options = {}) {
    let source: string | undefined;
    let scanners = new Set<TableScanner>();
    const track = (scanner: TableScanner) => {
      const scope = scanners;
      scope.add(scanner);
      return () => { scope.delete(scanner); scanner.dispose(); };
    };
    const state: ParseState = {
      links: [], footnotes: [], depth: 0, hasTableDefinitions: false,
    };
    /** 同步解析拥有独立源文本作用域；嵌套单元格解析结束后恢复外层坐标系。 */
    function withSource<T>(value: string, parse: () => T): T {
      const previous = source;
      const previousDepth = state.depth;
      const previousScanners = scanners;
      scanners = new Set();
      source = value;
      state.depth++;
      try {
        return parse();
      } finally {
        for (const scanner of scanners) scanner.dispose();
        scanners = previousScanners;
        source = previous;
        state.depth = previousDepth;
      }
    }
    const parser = this.parser;
    if (parser)
      this.parser = (value, file) => {
        const previous = { ...state };
        state.links = [];
        state.footnotes = [];
        state.depth = 0;
        state.hasTableDefinitions = false;
        try {
          return withSource(value, () => {
            const tree = parser(value, file) as Root;
            // 常见的内联表格没有块定义，不为这个少数场景追加全树遍历。
            if (!state.hasTableDefinitions) return tree;
            const discovered = tableReferenceSeeds(tree);
            if (!discovered.links.length && !discovered.footnotes.length)
              return tree;
            // 单元格块定义在首轮 hydrate 才可见；最多重跑一次，让表外及其他格
            // 的引用也经过宿主 inline tokenizer，避免改写已经生成的 text 节点。
            state.links = discovered.links;
            state.footnotes = discovered.footnotes;
            return parser(value, file);
          });
        } finally {
          Object.assign(state, previous);
        }
      };
    const data = this.data();
    const syntax = (data.micromarkExtensions ||= []);
    const mdast = (data.fromMarkdownExtensions ||= []);
    syntax.push(multimdSyntax(options, () => source, initializeReferences(state), track));
    mdast.push(multimdFromMarkdown(() => ({ syntax, mdast }), withSource, state));
  };

export default remarkMultimdTable;
