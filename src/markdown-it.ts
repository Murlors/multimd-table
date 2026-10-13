import type { MarkdownIt, StateBlock, Token } from "markdown-it";
import { TableScanner, type Options, type Range } from "./core.js";

/**
 * 替换 markdown-it 的原生 table 规则，保留宿主的启用状态和渲染流水线。
 * CommonMark preset 默认关闭 table；使用该 preset 时须显式 enable("table")。
 */
export default function markdownItMultimdTable(
  md: MarkdownIt,
  options: Options = {},
): void {
  const settings = { ...options };
  const failures = new WeakMap<
    StateBlock,
    { source: string; lines: Set<string> }
  >();
  const context = (state: StateBlock, line: number, endLine: number): string =>
    [
      line,
      endLine,
      state.blkIndent,
      state.listIndent,
      state.bMarks[line],
      state.eMarks[line],
      state.tShift[line],
      state.sCount[line],
      state.bsCount[line],
    ].join(":");
  const tabCodeIndent = (state: StateBlock, line: number): boolean => {
    if (state.sCount[line]! - state.blkIndent < 4) return false;
    let indent = 0;
    const begin = state.bMarks[line]!;
    for (let pos = begin; pos < begin + state.tShift[line]!; pos++) {
      if (state.src.charCodeAt(pos) === 9) {
        indent += 4 - (indent + state.bsCount[line]!) % 4;
        // 完全属于容器的 Tab 不影响表头；跨越容器边界的 Tab 保留代码缩进语义。
        if (indent > state.blkIndent) return true;
      } else indent++;
    }
    return false;
  };

  function tableRule(
    state: StateBlock,
    startLine: number,
    endLine: number,
    silent: boolean,
  ): boolean {
    if (startLine + 2 > endLine) return false;
    const terminators = state.md.block.ruler
      .getRules("paragraph")
      .filter((rule) => rule !== tableRule);
    const first = state.src[state.bMarks[startLine]! + state.tShift[startLine]!];
    // 只询问代码围栏/HTML 的宿主 owner；列表、标题等仍可作为合法管道表头。
    if (
      (first === "`" || first === "~" || first === "<") &&
      terminators.some((rule) => rule(state, startLine, endLine, true))
    )
      return false;
    const failed = failures.get(state);
    if (failed?.source === state.src && failed.lines.has(context(state, startLine, endLine)))
      return false;

    const scanner = new TableScanner(settings);
    const lineOffsets: number[] = [];
    let offset = 0;
    let continued = false;
    const parentType = state.parentType;
    // getLines 处理引用/列表前缀及 Tab；只去掉容器缩进，保留块级单元格的缩进。
    state.parentType = "table";
    try {
      for (let line = startLine; line < endLine; line++) {
        if (!state.isEmpty(line) && state.sCount[line]! < state.blkIndent)
          break;
        const value = state.getLines(line, line + 1, state.blkIndent, false);
        const nextContinued = scanner.options.multiline && value.endsWith("\\");
        if (
          !scanner.committed &&
          !continued &&
          !nextContinued &&
          tabCodeIndent(state, line)
        )
          break;
        // 提交后的合法管道行属于表格；识别失败时，外层块级语法交回宿主。
        if (
          line > startLine &&
          !scanner.committed &&
          !continued &&
          !nextContinued &&
          terminators.some((rule) => rule(state, line, endLine, true))
        )
          break;
        if (!scanner.push(value, offset)) break;
        if (silent && scanner.accepted) return true;
        lineOffsets.push(offset);
        offset += value.length + 1;
        continued = nextContinued;
        if (scanner.finished) break;
      }
    } finally {
      state.parentType = parentType;
    }

    if (!scanner.accepted) {
      if (!scanner.committed && lineOffsets.length) {
        const cache = failed?.source === state.src
          ? failed
          : { source: state.src, lines: new Set<string>() };
        // 无分隔行的已扫描段，其后缀同样不能成表；容器修改行标记后须重新识别。
        for (let index = 0; index < lineOffsets.length; index++)
          cache.lines.add(context(state, startLine + index, endLine));
        failures.set(state, cache);
      }
      return false;
    }
    if (silent) return true;
    const table = scanner.finish()!;

    // 模型使用去前缀后的 UTF-16 偏移；映射回当前文档的真实行号。
    const lineAt = (position: number): number => {
      let low = 0;
      let high = lineOffsets.length;
      while (low + 1 < high) {
        const middle = (low + high) >>> 1;
        if (lineOffsets[middle]! <= position) low = middle;
        else high = middle;
      }
      return startLine + low;
    };
    const map = (range: Range): [number, number] => [
      lineAt(range.start),
      lineAt(Math.max(range.start, range.end - 1)) + 1,
    ];
    const inline = (content: string, range: Range): void => {
      const token = state.push("inline", "", 0);
      token.content = content;
      token.map = map(range);
      token.children = [];
    };

    state.push("table_open", "table", 1).map = map(table.range);
    if (table.caption) {
      const caption = table.caption;
      const token = state.push("caption_open", "caption", 1);
      token.map = map(caption.range);
      if (caption.id !== null) token.attrSet("id", caption.id);
      if (caption.side === "bottom")
        token.attrSet("style", "caption-side: bottom");
      inline(caption.value, caption.contentRange);
      state.push("caption_close", "caption", -1);
    }
    for (const section of table.sections) {
      const sectionTag = section.kind === "head" ? "thead" : "tbody";
      const cellTag = section.kind === "head" ? "th" : "td";
      state.push(`${sectionTag}_open`, sectionTag, 1).map = map(section.range);
      for (const row of section.rows) {
        state.push("tr_open", "tr", 1).map = map(row.range);
        for (const cell of row.cells) {
          const token = state.push(`${cellTag}_open`, cellTag, 1);
          token.map = map(cell.range);
          if (cell.align) token.attrSet("style", `text-align:${cell.align}`);
          if (cell.wrap) token.attrSet("class", "extend");
          if (cell.colspan > 1) token.attrSet("colspan", cell.colspan);
          if (cell.rowspan > 1) token.attrSet("rowspan", cell.rowspan);
          if (cell.block) {
            const tokens: Token[] = [];
            // 共用 env 收集定义；inline 留给宿主 core 阶段统一解析后置引用和插件。
            state.md.block.parse(cell.value, state.md, state.env, tokens);
            for (const nested of tokens) {
              nested.level += state.level;
              if (nested.map) {
                const [begin, end] = nested.map;
                nested.map = [
                  lineAt(cell.segments[begin]?.start ?? cell.range.start),
                  lineAt(
                    cell.segments[Math.min(end, cell.segments.length) - 1]
                      ?.start ?? cell.range.end,
                  ) + 1,
                ];
              }
              state.tokens.push(nested);
            }
          } else inline(cell.value, cell.range);
          state.push(`${cellTag}_close`, cellTag, -1);
        }
        state.push("tr_close", "tr", -1);
      }
      state.push(`${sectionTag}_close`, sectionTag, -1);
    }
    state.push("table_close", "table", -1);
    state.line = map(table.range)[1];
    return true;
  }

  md.block.ruler.at("table", tableRule, { alt: ["paragraph", "reference"] });
}
