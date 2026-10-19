"""共享核心验证绑定；仅使用标准库 ctypes，UTF-16 偏移与 JS 保持一致。"""
import ctypes as c
import json
from pathlib import Path
import struct
import sys


class Reader:
    def __init__(self, data):
        self.data, self.offset = data, 0

    def number(self):
        value, = struct.unpack_from("<I", self.data, self.offset)
        self.offset += 4
        return value

    def text(self):
        length = self.number() * 2
        start = self.offset
        self.offset += length
        if self.offset > len(self.data):
            raise ValueError("Truncated response")
        return bytes(self.data[start:self.offset]).decode("utf-16-le", "surrogatepass")

class Core:
    def __init__(self, library=None):
        name = "multimd_table_core.dll" if sys.platform == "win32" else "libmultimd_table_core" + (".dylib" if sys.platform == "darwin" else ".so")
        path = library or Path(__file__).resolve().parent.parent / "target" / "release" / name
        self.library_path = Path(path).resolve()
        self.lib = c.CDLL(str(self.library_path))
        for name, args, result in [
            ("mm_parse_json", [c.c_void_p, c.c_size_t, c.c_uint32], c.c_void_p),
            ("mm_write", [c.c_void_p, c.c_size_t], c.c_void_p),
            ("mm_result_ptr", [c.c_void_p], c.c_void_p),
            ("mm_result_len", [c.c_void_p], c.c_size_t),
            ("mm_result_free", [c.c_void_p], None),
        ]:
            function = getattr(self.lib, name)
            function.argtypes, function.restype = args, result

    def _result(self, pointer, decode):
        try:
            length = self.lib.mm_result_len(pointer)
            # 在结果释放前完成解码，避免整体响应复制及悬空视图。
            data = (c.c_ubyte * length).from_address(self.lib.mm_result_ptr(pointer))
            reader = Reader(data)
            value = decode(reader)
            if reader.offset != length:
                raise ValueError("Trailing response bytes")
            return value
        finally:
            self.lib.mm_result_free(pointer)

    def parse_table(self, source, options=None):
        if not isinstance(source, str):
            raise TypeError("Expected Markdown string")
        settings = {"multiline": False, "rowspan": False, "headerless": False, "multibody": True, "autolabel": True}
        settings.update(options or {})
        flags = sum(bool(settings[key]) << i for i, key in enumerate(settings))
        raw = source.encode("utf-16-le", "surrogatepass")
        units = (c.c_uint16 * (len(raw) // 2)).from_buffer_copy(raw)
        pointer = self.lib.mm_parse_json(units, len(units), flags)
        try:
            raw = c.string_at(self.lib.mm_result_ptr(pointer), self.lib.mm_result_len(pointer))
            return json.loads(raw)
        finally:
            self.lib.mm_result_free(pointer)

    def stringify_table(self, table):
        output = bytearray()

        def number(value):
            if type(value) is not int or not 0 <= value <= 0xffffffff:
                raise ValueError("Invalid writer number")
            output.extend(struct.pack("<I", value))

        def text(value):
            raw = value.encode("utf-16-le", "surrogatepass")
            number(len(raw) // 2)
            output.extend(raw)

        number(len(table["columns"]))
        for col in table["columns"]:
            number((None, "left", "center", "right").index(col["align"]))
            number(int(bool(col.get("wrap"))))
        number(len(table["sections"]))
        for section in table["sections"]:
            number(("head", "body").index(section["kind"]))
            number(len(section["rows"]))
            for row in section["rows"]:
                number(len(row["cells"]))
                for cell in row["cells"]:
                    number(cell["column"])
                    number(cell.get("colspan", 1))
                    number(cell.get("rowspan", 1))
                    number(int(bool(cell.get("block"))))
                    text(cell["value"])
        caption = table.get("caption")
        number(int(bool(caption)))
        if caption:
            text(caption["value"])
            number(0 if "id" not in caption else 1 if caption["id"] is None else 2)
            if caption.get("id") is not None:
                text(caption["id"])
            number(("top", "bottom").index(caption["side"]))
        units = (c.c_uint16 * (len(output) // 2)).from_buffer_copy(output)

        def decode(reader):
            failed, value = reader.number(), reader.text()
            if failed:
                raise ValueError(value)
            return value
        return self._result(self.lib.mm_write(units, len(units)), decode)


if __name__ == "__main__":
    import json
    core = Core()
    cases = json.load(open(sys.argv[1], encoding="utf8"))
    for case in cases:
        actual = core.parse_table(case["source"], case["options"])
        assert actual == case["model"], case["id"]
        if "written" in case:
            assert core.stringify_table(actual) == case["written"], case["id"]
    print(f"Python native: {len(cases)} full models and representable writer results passed")
