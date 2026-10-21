"""markdown-it-py 适配；语法归共享核心，容器、行内解析及 renderer 归宿主。"""

from bisect import bisect_right
from typing import Unpack
from weakref import WeakKeyDictionary

from markdown_it import MarkdownIt
from markdown_it.rules_block import StateBlock
from markdown_it.token import Token

from . import TableScanner
from .types import Options, Range


def multimd_table_plugin(md: MarkdownIt, **options: Unpack[Options]) -> None:
    """替换 table 规则并保留启用状态；commonmark preset 须显式 enable('table')。"""
    settings = options.copy()
    with TableScanner(**settings):
        pass  # 安装插件时即校验选项，不等到首次遇到表格。
    failures: WeakKeyDictionary[StateBlock, tuple[str, set[tuple[int, ...]]]] = WeakKeyDictionary()

    def context(state: StateBlock, line: int, end: int) -> tuple[int, ...]:
        return (line, end, state.blkIndent, state.listIndent, state.bMarks[line],
                state.eMarks[line], state.tShift[line], state.sCount[line], state.bsCount[line])

    def tab_code_indent(state: StateBlock, line: int) -> bool:
        if state.sCount[line] - state.blkIndent < 4:
            return False
        indent = 0
        begin = state.bMarks[line]
        for char in state.src[begin:begin + state.tShift[line]]:
            if char == "\t":
                indent += 4 - (indent + state.bsCount[line]) % 4
                if indent > state.blkIndent:
                    return True
            else:
                indent += 1
        return False

    def table_rule(state: StateBlock, start: int, end: int, silent: bool) -> bool:
        if start + 2 > end:
            return False
        terminators = [rule for rule in state.md.block.ruler.getRules("paragraph")
                       if rule is not table_rule]
        pos = state.bMarks[start] + state.tShift[start]
        first = state.src[pos:pos + 1]
        if first in ("`", "~", "<") and any(rule(state, start, end, True) for rule in terminators):
            return False
        failed = failures.get(state)
        if failed and failed[0] == state.src and context(state, start, end) in failed[1]:
            return False

        with TableScanner(**settings) as scanner:
            offsets: list[int] = []
            offset = 0
            continued = False
            parent = state.parentType
            state.parentType = "table"
            try:
                for line in range(start, end):
                    if not state.isEmpty(line) and state.sCount[line] < state.blkIndent:
                        break
                    value = state.getLines(line, line + 1, state.blkIndent, False)
                    next_continued = bool(settings.get("multiline") and value.endswith("\\"))
                    if not scanner.committed and not continued and not next_continued:
                        if tab_code_indent(state, line):
                            break
                        if line > start and any(rule(state, line, end, True) for rule in terminators):
                            break
                    if not scanner.push(value, offset):
                        break
                    if silent and scanner.accepted:
                        return True
                    offsets.append(offset)
                    # Python 字符索引与核心 UTF-16 坐标分开；包含孤立代理项时也不丢失内容。
                    offset += len(value.encode("utf-16-le", "surrogatepass")) // 2 + 1
                    continued = next_continued
                    if scanner.finished:
                        break
            finally:
                state.parentType = parent

            if not scanner.accepted:
                if not scanner.committed and offsets:
                    rejected = failed[1] if failed and failed[0] == state.src else set()
                    rejected.update(context(state, start + i, end) for i in range(len(offsets)))
                    failures[state] = (state.src, rejected)
                return False
            if silent:
                return True
            table = scanner.finish()
            assert table is not None

        def line_at(position: int) -> int:
            return start + max(0, bisect_right(offsets, position) - 1)

        def source_map(span: Range) -> list[int]:
            return [line_at(span["start"]), line_at(max(span["start"], span["end"] - 1)) + 1]

        def inline(content: str, span: Range) -> None:
            token = state.push("inline", "", 0)
            token.content = content
            token.map = source_map(span)
            token.children = []

        state.push("table_open", "table", 1).map = source_map(table["range"])
        caption = table["caption"]
        if caption is not None:
            token = state.push("caption_open", "caption", 1)
            token.map = source_map(caption["range"])
            if caption["id"] is not None:
                token.attrSet("id", caption["id"])
            if caption["side"] == "bottom":
                token.attrSet("style", "caption-side: bottom")
            inline(caption["value"], caption["contentRange"])
            state.push("caption_close", "caption", -1)
        for section in table["sections"]:
            tag = "thead" if section["kind"] == "head" else "tbody"
            cell_tag = "th" if section["kind"] == "head" else "td"
            state.push(f"{tag}_open", tag, 1).map = source_map(section["range"])
            for row in section["rows"]:
                state.push("tr_open", "tr", 1).map = source_map(row["range"])
                for cell in row["cells"]:
                    token = state.push(f"{cell_tag}_open", cell_tag, 1)
                    token.map = source_map(cell["range"])
                    if cell["align"]:
                        token.attrSet("style", f'text-align:{cell["align"]}')
                    if cell["wrap"]:
                        token.attrSet("class", "extend")
                    for attr, span in (("colspan", cell["colspan"]), ("rowspan", cell["rowspan"])):
                        if span > 1:
                            token.attrSet(attr, span)
                    if cell["block"]:
                        nested_tokens: list[Token] = []
                        state.md.block.parse(cell["value"], state.md, state.env, nested_tokens)
                        segments = cell["segments"]
                        for nested in nested_tokens:
                            nested.level += state.level
                            if nested.map:
                                begin, finish = nested.map
                                first_span = segments[begin] if begin < len(segments) else cell["range"]
                                last = min(finish, len(segments)) - 1
                                last_start = segments[last]["start"] if last >= 0 else cell["range"]["end"]
                                nested.map = [line_at(first_span["start"]), line_at(last_start) + 1]
                            state.tokens.append(nested)
                    else:
                        inline(cell["value"], cell["range"])
                    state.push(f"{cell_tag}_close", cell_tag, -1)
                state.push("tr_close", "tr", -1)
            state.push(f"{tag}_close", tag, -1)
        state.push("table_close", "table", -1)
        state.line = source_map(table["range"])[1]
        return True

    md.block.ruler.at("table", table_rule, {"alt": ["paragraph", "reference"]})
