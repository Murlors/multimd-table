import type { MarkedExtension, Token, TokenizerThis, Tokens } from "marked";
import { TableScanner } from "./core.js";
import type { Options, Table } from "./core.js";

/** 原生表格 token；子 token 由同一 Marked lexer 解析并交给宿主遍历、渲染。 */
export interface MarkedMultimdTableToken extends Tokens.Generic {
  type: "multimdTable";
  model: Table;
  cellTokens: Token[][];
  captionTokens: Token[];
}

interface FailedHeaders {
  lengths: Set<number>;
  endLength: number;
  nextStartLength?: number | null;
}

interface LexingFrame {
  failedHeaders: WeakMap<Token[], FailedHeaders>;
  startHint?: { length: number; from: number; failed: FailedHeaders };
  /** 同一 blockTokens 帧内已确认没有后续表格的后缀长度上界。 */
  noStartFromLength?: number;
}

/** 保留宿主块级语法的起始边界；四空格表头仍由核心分隔行规则判断。 */
function startsHostBlock(
  value: string,
  lexer: TokenizerThis["lexer"],
  continued = false,
): boolean {
  const rules = lexer.options.tokenizer!.rules.block;
  const line = value + "\n";
  return (
    // 显式多行续行中的 Tab 属于块单元格；其他 Tab 首部交给宿主代码语法。
    (!continued && /^ *\t/.test(value)) ||
    rules.fences.test(line) ||
    rules.heading.test(line) ||
    rules.hr.test(line) ||
    rules.blockquote.test(line) ||
    rules.list.test(line) ||
    rules.html.test(line) ||
    rules.def.test(line)
  );
}

/** 每条候选行只向前扫描一次，不把失败的管道文本逐行当作新表格试探。 */
function nextTableStart(
  source: string,
  options: Options,
  lexer: TokenizerThis["lexer"],
  from = 0,
): number | undefined {
  // Marked 传入的是当前源文去掉首字符的后缀；首行不是完整物理行。
  let offset = source.indexOf("\n");
  if (offset < 0) return;
  offset = Math.max(offset + 1, from);
  let scanner: TableScanner | undefined;
  let start = offset;
  let previousContinued = false;
  try {
    while (offset < source.length) {
      const newline = source.indexOf("\n", offset);
      const end = newline < 0 ? source.length : newline;
      const value = source.slice(offset, end);
      const continued = !!options.multiline && (previousContinued || value.endsWith("\\"));
      const hostBlock = !scanner?.committed && startsHostBlock(value, lexer, continued);
      if (hostBlock) {
        scanner?.dispose();
        scanner = undefined;
        previousContinued = false;
      } else {
        if (scanner && !scanner.push(value, offset)) { scanner.dispose(); scanner = undefined; }
        if (!scanner) {
          scanner = new TableScanner(options);
          start = offset;
          if (!scanner.push(value, offset)) { scanner.dispose(); scanner = undefined; }
        }
        previousContinued = !!scanner && !!options.multiline && value.endsWith("\\");
        if (scanner?.accepted) return start;
      }
      if (newline < 0) break;
      offset = newline + 1;
    }
  } finally { scanner?.dispose(); }
}

/** 块单元格共享文档引用定义；嵌套解析结束后恢复外层 lexer 的状态。 */
function blockContents(value: string, lexer: TokenizerThis["lexer"]): Token[] {
  const previous = { ...lexer.state };
  try {
    lexer.state.top = true;
    return lexer.blockTokens(value, []);
  } finally {
    Object.assign(lexer.state, previous);
  }
}

/** 安装 MultiMarkdown 原生块扩展；可传给 new Marked(...) 或 instance.use(...)。 */
export function markedMultimdTable(options: Options = {}): MarkedExtension {
  const settings = { ...options };
  const scopes = new WeakMap<TokenizerThis["lexer"], { frame: LexingFrame }>();

  /**
   * 失败扫描归属于一次 blockTokens 调用，而非可被多个引用分段复用的 tokens。
   * 首次进入扩展时外层调用已经开始；之后透明保留宿主方法、this 和全部参数。
   */
  function lexingFrame(lexer: TokenizerThis["lexer"]): LexingFrame {
    let scope = scopes.get(lexer);
    if (!scope) {
      scope = { frame: { failedHeaders: new WeakMap() } };
      scopes.set(lexer, scope);
      const currentScope = scope;
      const blockTokens = lexer.blockTokens;
      lexer.blockTokens = (function (
        this: TokenizerThis["lexer"],
        ...args: Parameters<typeof blockTokens>
      ) {
        const previous = currentScope.frame;
        currentScope.frame = { failedHeaders: new WeakMap() };
        try {
          return Reflect.apply(blockTokens, this, args);
        } finally {
          currentScope.frame = previous;
        }
      }) as typeof blockTokens;
    }
    return scope.frame;
  }
  return {
    extensions: [
      {
        name: "multimdTable",
        level: "block",
        childTokens: ["cellTokens", "captionTokens"],
        start(source) {
          const frame = lexingFrame(this.lexer);
          // 普通段落可能连一行候选表头都没有，仍须复用整段查找的否定结果。
          if (frame.noStartFromLength !== undefined && source.length <= frame.noStartFromLength)
            return;
          const hint = frame.startHint;
          const active = hint?.length === source.length ? hint : undefined;
          if (active?.failed.nextStartLength !== undefined)
            return active.failed.nextStartLength === null
              ? undefined
              : source.length - active.failed.nextStartLength;
          const start = nextTableStart(
            source,
            settings,
            this.lexer,
            active?.from,
          );
          if (start === undefined)
            frame.noStartFromLength = Math.max(frame.noStartFromLength ?? 0, source.length);
          // 同一失败段后的寻找结果也只扫描一次，list 中的逐行 text 可直接复用。
          if (active) active.failed.nextStartLength = start === undefined ? null : source.length - start;
          return start;
        },
        tokenizer(source, tokens): MarkedMultimdTableToken | undefined {
          const frame = lexingFrame(this.lexer);
          delete frame.startHint;
          const failed = frame.failedHeaders.get(tokens);
          if (failed?.lengths.has(source.length)) {
            frame.startHint = {
              length: source.length - 1,
              from: Math.max(0, source.length - failed.endLength - 1),
              failed,
            };
            return;
          }
          frame.failedHeaders.delete(tokens);
          const scanner = new TableScanner(settings);
          let offset = 0;
          let scannedEnd = 0;
          let previousContinued = false;
          const failedLengths: number[] = [];
          let model: Table | null;
          try {
            while (offset < source.length) {
              const newline = source.indexOf("\n", offset);
              const end = newline < 0 ? source.length : newline;
              const value = source.slice(offset, end);
              const continued = !!settings.multiline && (previousContinued || value.endsWith("\\"));
              if (!scanner.committed && startsHostBlock(value, this.lexer, continued)) break;
              if (!scanner.push(value, offset)) break;
              previousContinued = !!settings.multiline && value.endsWith("\\");
              if (!scanner.committed) {
                failedLengths.push(source.length - offset);
                // 原生 text 不消费行末换行；space 回调仍在同一个已否定的候选段内。
                if (newline >= 0) failedLengths.push(source.length - end);
              }
              scannedEnd = newline < 0 ? end : end + 1;
              if (scanner.finished) break;
              if (newline < 0) break;
              offset = newline + 1;
            }
            model = scanner.finish();
          } finally { scanner.dispose(); }
          if (!model) {
            if (!scanner.committed && failedLengths.length) {
              const failed: FailedHeaders = {
                lengths: new Set(failedLengths),
                endLength: source.length - scannedEnd,
              };
              frame.failedHeaders.set(tokens, failed);
              frame.startHint = {
                length: source.length - 1,
                from: scannedEnd - 1,
                failed,
              };
            }
            return;
          }
          const cellTokens = model.sections.flatMap((section) =>
            section.rows.flatMap((row) =>
              row.cells.map((cell) =>
                cell.block
                  ? blockContents(cell.value, this.lexer)
                  : this.lexer.inline(cell.value),
              ),
            ),
          );
          const captionTokens = model.caption
            ? this.lexer.inline(model.caption.value)
            : [];
          return {
            type: "multimdTable",
            raw: source.slice(0, model.range.end),
            model,
            cellTokens,
            captionTokens,
          };
        },
        renderer(generic) {
          const token = generic as MarkedMultimdTableToken;
          let html = "<table>\n";
          const caption = token.model.caption;
          if (caption) {
            const id = caption.id === null ? "" : ` id="${caption.id}"`;
            const side = caption.side === "bottom" ? ' style="caption-side: bottom"' : "";
            html += `<caption${id}${side}>${this.parser.parseInline(token.captionTokens)}</caption>\n`;
          }
          let index = 0;
          for (const section of token.model.sections) {
            const sectionTag = section.kind === "head" ? "thead" : "tbody";
            const cellTag = section.kind === "head" ? "th" : "td";
            html += `<${sectionTag}>\n`;
            for (const row of section.rows) {
              html += "<tr>\n";
              for (const cell of row.cells) {
                const children = token.cellTokens[index++]!;
                const contents = cell.block
                  ? this.parser.parse(children)
                  : this.parser.parseInline(children);
                const attrs =
                  (cell.align ? ` style="text-align:${cell.align}"` : "") +
                  (cell.wrap ? ' class="extend"' : "") +
                  (cell.colspan > 1 ? ` colspan="${cell.colspan}"` : "") +
                  (cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : "");
                html += `<${cellTag}${attrs}>${contents}</${cellTag}>\n`;
              }
              html += "</tr>\n";
            }
            html += `</${sectionTag}>\n`;
          }
          return html + "</table>\n";
        },
      },
    ],
  };
}

export default markedMultimdTable;
