"""供 mypy 对已安装 wheel 检查的独立消费者，不从源码别名导入。"""

from typing import assert_type
from multimd_table import (
    ExpandedCell, Options, Table, TableScanner, WriteTable,
    cell_bounds, expand_section, parse_table, stringify_table,
)

options: Options = {"rowspan": True, "multiline": True}
table = parse_table("A|B\n-|-\nx|y", **options)
assert_type(table, Table | None)
if table is not None:
    assert_type(stringify_table(table), str)
    assert_type(expand_section(table["sections"][0]), list[list[ExpandedCell | None]])
assert_type(cell_bounds("a|b"), list[int])
with TableScanner(**options) as scanner:
    scanner.options["rowspan"] = False
    assert_type(scanner.push("a|b", 0), bool)
    assert_type(scanner.finish(), Table | None)

written: WriteTable = {
    "columns": [{"align": None}],
    "sections": [{"kind": "body", "rows": [{"cells": [{"column": 0, "value": "x"}]}]}],
}
assert_type(stringify_table(written), str)
