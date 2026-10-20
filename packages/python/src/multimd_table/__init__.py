"""MultiMarkdown 表格核心 API；模型中的源位置按 UTF-16 单元计数。"""

from collections.abc import Mapping
from types import MappingProxyType

from ._native import TableScanner, cell_bounds, parse_table, stringify_table
from .types import (
    Alignment, Caption, Cell, Column, ExpandedCell, Options, Range, Row, Section,
    Table, WriteCaption, WriteCell, WriteColumn, WriteRow, WriteSection, WriteTable,
)

__all__ = [
    "TableScanner", "cell_bounds", "parse_table", "stringify_table", "expand_section",
    "defaults", "Alignment", "Caption", "Cell", "Column", "ExpandedCell", "Options",
    "Range", "Row", "Section", "Table", "WriteCaption", "WriteCell", "WriteColumn",
    "WriteRow", "WriteSection", "WriteTable",
]

defaults: Mapping[str, bool] = MappingProxyType({
    "multiline": False, "rowspan": False, "headerless": False,
    "multibody": True, "autolabel": True,
})


def expand_section(section: Section) -> list[list[ExpandedCell | None]]:
    """展开单个分区的合并单元格；origin 保留输入单元格身份，空洞为 None。"""
    rows = section["rows"]
    width = max(
        (cell["column"] + cell["colspan"] for row in rows for cell in row["cells"]),
        default=0,
    )
    grid: list[list[ExpandedCell | None]] = [[None] * width for _ in rows]
    for row_index, row in enumerate(rows):
        for cell in row["cells"]:
            for down in range(min(cell["rowspan"], len(rows) - row_index)):
                for right in range(cell["colspan"]):
                    grid[row_index + down][cell["column"] + right] = {
                        "value": cell["value"], "origin": cell,
                        "inherited": down > 0 or right > 0,
                    }
    return grid
