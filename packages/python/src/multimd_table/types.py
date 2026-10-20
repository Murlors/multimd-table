"""与共享核心一致的模型；所有源范围均为 UTF-16 半开区间。"""

from typing import Literal, NotRequired, TypedDict

Alignment = Literal["left", "center", "right"] | None


class Options(TypedDict, total=False):
    multiline: bool
    rowspan: bool
    headerless: bool
    multibody: bool
    autolabel: bool


class Range(TypedDict):
    start: int
    end: int


class Column(TypedDict):
    align: Alignment
    wrap: bool


class Cell(TypedDict):
    column: int
    colspan: int
    rowspan: int
    align: Alignment
    wrap: bool
    value: str
    block: bool
    segments: list[Range]
    range: Range


class Row(TypedDict):
    cells: list[Cell]
    range: Range


class Section(TypedDict):
    kind: Literal["head", "body"]
    rows: list[Row]
    range: Range


class Caption(TypedDict):
    value: str
    id: str | None
    side: Literal["top", "bottom"]
    range: Range
    contentRange: Range


class Table(TypedDict):
    type: Literal["multimdTable"]
    columns: list[Column]
    caption: Caption | None
    sections: list[Section]
    range: Range


class ExpandedCell(TypedDict):
    value: str
    origin: Cell
    inherited: bool


class WriteColumn(TypedDict):
    align: Alignment
    wrap: NotRequired[bool]


class WriteCell(TypedDict):
    column: int
    value: str
    colspan: NotRequired[int]
    rowspan: NotRequired[int]
    block: NotRequired[bool]


class WriteRow(TypedDict):
    cells: list[WriteCell]


class WriteSection(TypedDict):
    kind: Literal["head", "body"]
    rows: list[WriteRow]


class WriteCaption(TypedDict):
    value: str
    side: Literal["top", "bottom"]
    id: NotRequired[str | None]


class WriteTable(TypedDict):
    columns: list[WriteColumn]
    sections: list[WriteSection]
    caption: NotRequired[WriteCaption | None]
