import copy
import gc
import hashlib
import json
import os
from pathlib import Path
import re
import unittest
from concurrent.futures import ThreadPoolExecutor

from multimd_table import (
    TableScanner, cell_bounds, defaults, expand_section, parse_table, stringify_table,
)


def utf16_length(value):
    return len(value.encode("utf-16-le", "surrogatepass")) // 2


def scan(source, options):
    offset = 0
    with TableScanner(**options) as scanner:
        for match in re.finditer(r"([^\r\n]*)(\r\n|\r|\n|$)", source):
            if not match.group(0):
                break
            if not scanner.push(match.group(1), offset) or scanner.finished:
                break
            offset += utf16_length(match.group(0))
        return scanner.finish()


class CoreTests(unittest.TestCase):
    def test_parse_edit_write_and_leading_table(self):
        self.assertIsNone(parse_table("paragraph\n\nA|B\n-|-"))
        table = parse_table("A|B\n-|-\nx|y\nparagraph")
        self.assertEqual(table["range"], {"start": 0, "end": 11})
        table["sections"][1]["rows"][0]["cells"][1]["value"] = "edited"
        before = copy.deepcopy(table)
        written = stringify_table(table)
        self.assertFalse(written.endswith("\n"))
        self.assertEqual(parse_table(written)["sections"][1]["rows"][0]["cells"][1]["value"], "edited")
        self.assertEqual(table, before)

    def test_options_defaults_and_types(self):
        self.assertEqual(dict(defaults), {"multiline": False, "rowspan": False, "headerless": False, "multibody": True, "autolabel": True})
        with self.assertRaises(TypeError):
            defaults["multiline"] = True
        for source in [None, b"A|B", 123]:
            with self.subTest(source=source), self.assertRaises(TypeError):
                parse_table(source)
        with self.assertRaises(TypeError):
            parse_table("A|B", unknown=True)
        with self.assertRaises(TypeError):
            parse_table("A|B", multiline="yes")
        with self.assertRaises(TypeError):
            cell_bounds(b"A|B")

    def test_utf16_and_surrogates(self):
        source = "😀|\ud800\r\n-|-\r\n\udc00|\ufeffinside"
        table = parse_table(source)
        self.assertEqual(table["range"]["end"], utf16_length(source))
        self.assertEqual(table["sections"][0]["rows"][0]["cells"][0]["value"], "😀")
        self.assertEqual(table["sections"][0]["rows"][0]["cells"][1]["value"], "\ud800")
        self.assertEqual(table["sections"][1]["rows"][0]["cells"][0]["value"], "\udc00")
        self.assertEqual(scan(source, {}), table)
        self.assertIn("\udc00", stringify_table(table))
        self.assertEqual(cell_bounds("😀|`a|b`|\\|c"), [-1, 2, 8, 12])

    def test_expansion_identity_and_holes(self):
        cell = {"column": 1, "colspan": 2, "rowspan": 2, "value": "merged"}
        section = {"kind": "body", "rows": [{"cells": [cell]}, {"cells": []}]}
        before = copy.deepcopy(section)
        grid = expand_section(section)
        self.assertEqual(len(grid), 2)
        self.assertIsNone(grid[0][0])
        self.assertIs(grid[1][2]["origin"], cell)
        self.assertTrue(grid[1][2]["inherited"])
        self.assertFalse(grid[0][1]["inherited"])
        self.assertIsNot(grid[0][1], grid[1][1])
        self.assertEqual(section, before)

    def test_scanner_snapshots_options_offsets_and_disposal(self):
        scanner = TableScanner()
        self.assertIsNone(scanner.finish())
        self.assertFalse(scanner.accepted)
        offset = 2**40 + 100
        self.assertTrue(scanner.push("A|B", offset))
        self.assertTrue(scanner.push("-|-", 17))
        self.assertTrue(scanner.committed)
        first = scanner.finish()
        self.assertEqual(first["range"], {"start": offset, "end": 20})
        self.assertTrue(scanner.push("x|y", 17))
        second = scanner.finish()
        self.assertEqual(second["sections"][1]["rows"][0]["cells"][0]["value"], "x")
        self.assertEqual(len(first["sections"]), 1)
        scanner.options["rowspan"] = True
        self.assertTrue(scanner.push("^^|z", 6))
        third = scanner.finish()
        self.assertEqual(third["sections"][1]["rows"][0]["cells"][0]["rowspan"], 2)
        self.assertEqual(second["sections"][1]["rows"][0]["cells"][0]["rowspan"], 1)
        scanner.dispose()
        scanner.dispose()
        self.assertTrue(scanner.disposed)
        self.assertEqual(first["sections"][0]["rows"][0]["cells"][0]["value"], "A")
        for action in [lambda: scanner.push("x|y", 0), scanner.finish, scanner.__enter__]:
            with self.assertRaises(RuntimeError):
                action()

    def test_scanner_rejection_closed_and_offset_validation(self):
        with TableScanner() as scanner:
            for offset in [-1, 2**53, 1.5, True, "0"]:
                with self.subTest(offset=offset), self.assertRaises(ValueError):
                    scanner.push("A|B", offset)
            with self.assertRaises(ValueError):
                scanner.push("😀|x", 2**53 - 2)
            scanner.push("A|B", 0)
            scanner.push("-|-", 4)
            before = scanner.finish()
            self.assertFalse(scanner.push("paragraph", 8))
            self.assertEqual(scanner.finish(), before)
            scanner.push("[caption]", 8)
            self.assertTrue(scanner.finished)
            self.assertFalse(scanner.push(None, None))

    def test_context_exception_and_cycle_cleanup(self):
        scanner = TableScanner()
        with self.assertRaisesRegex(ValueError, "caller"):
            with scanner:
                scanner.push("A|B", 0)
                raise ValueError("caller")
        self.assertTrue(scanner.disposed)
        released = []

        class Marker:
            def __del__(self):
                released.append(True)

        scanner = TableScanner()
        scanner.options["self"] = scanner
        scanner.options["marker"] = Marker()
        del scanner
        gc.collect()
        self.assertEqual(released, [True])

    def test_writer_rejections_and_minimal_model(self):
        table = {"columns": [{"align": None}], "sections": [{"kind": "body", "rows": [{"cells": [{"column": 0, "value": "x"}]}]}]}
        self.assertEqual(stringify_table(table), "|---|\n| x |")
        for change in [{"rowspan": 0}, {"rowspan": 2}, {"column": 1}, {"colspan": 2}, {"column": -1}, {"column": 2**40}]:
            invalid = copy.deepcopy(table)
            invalid["sections"][0]["rows"][0]["cells"][0].update(change)
            with self.subTest(change=change), self.assertRaises(ValueError):
                stringify_table(invalid)
        for value in [True, 0.5, "0"]:
            invalid = copy.deepcopy(table)
            invalid["sections"][0]["rows"][0]["cells"][0]["column"] = value
            with self.subTest(value=value), self.assertRaises(TypeError):
                stringify_table(invalid)
        for invalid in [{}, {"columns": [], "sections": []}]:
            with self.assertRaises(ValueError):
                stringify_table(invalid)
        with self.assertRaises(TypeError):
            stringify_table(None)
        invalid = copy.deepcopy(table)
        invalid["sections"][0]["rows"][0]["cells"][0].update(value="```\na|b\n```", block=True)
        with self.assertRaises(ValueError):
            stringify_table(invalid)

    def test_native_calls_from_threads(self):
        sources = ["A|B\n-|-\n" + "x|y\n" * 100 for _ in range(8)]
        expected = [stringify_table(parse_table(source)) for source in sources]
        with ThreadPoolExecutor(max_workers=4) as pool:
            self.assertEqual(list(pool.map(lambda source: stringify_table(parse_table(source)), sources)), expected)

    def test_unicode_writer_frozen_boundary_contract(self):
        values = [
            "```a\u2028b\nx\n```", "```a\u2029\nx\n```", "<a:x\u2028|y>",
            "<a:x\u00a0|y>", "<code>space \u2028\nnext</code>",
            "\u00a0# heading", "\u2028```a\nx\n```",
        ]
        results = []
        for value in values:
            table = {"columns": [{"align": None}, {"align": None}], "sections": [{
                "kind": "body", "rows": [{"cells": [
                    {"column": 0, "value": value, "block": value.startswith(("```", "\u2028```"))},
                    {"column": 1, "value": "first\nlast", "block": True},
                ]}],
            }]}
            try:
                results.append({"written": stringify_table(table)})
            except ValueError:
                results.append({"error": "RangeError"})
        canonical = json.dumps(results, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        golden = json.loads((Path(__file__).resolve().parents[3] / "contracts/core-contracts.json").read_text())
        self.assertEqual(hashlib.sha256(canonical.encode("utf-8")).hexdigest(), golden["writerBoundaries"])


@unittest.skipUnless(os.environ.get("MULTIMD_VECTORS"), "Set MULTIMD_VECTORS to the verified frozen-contract export")
class FrozenContracts(unittest.TestCase):
    def test_complete_models_writer_and_incremental_snapshots(self):
        cases = json.loads(Path(os.environ["MULTIMD_VECTORS"]).read_text(encoding="utf-8"))
        self.assertEqual(len(cases), 2130)
        for case in cases:
            with self.subTest(case=case["id"]):
                model = parse_table(case["source"], **case["options"])
                self.assertEqual(model, case["model"])
                self.assertEqual(scan(case["source"], case["options"]), case["model"])
                if "written" in case:
                    self.assertEqual(stringify_table(model), case["written"])
                elif model is not None:
                    with self.assertRaises(ValueError):
                        stringify_table(model)


if __name__ == "__main__":
    unittest.main()
