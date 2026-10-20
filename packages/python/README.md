# multimd-table for Python

Parse, edit and write MultiMarkdown tables with merged cells, multiline content
and source ranges. Python calls the same Rust grammar and writer as the npm package.

This is an unpublished development package for CPython 3.11 and newer.
The core has no Python runtime dependencies. Markdown rendering belongs to a host parser.

From the repository root, install into a virtual environment. Building from source
requires Rust:

```sh
python -m pip install ./packages/python
```

Installing a prebuilt wheel matching your Python version and platform does not
require Rust or maturin on the consumer's machine.

```python
from multimd_table import parse_table, stringify_table

table = parse_table("Name | Value\n--- | ---\napple | 1")
if table is not None:
    table["sections"][1]["rows"][0]["cells"][1]["value"] = "2"
    print(stringify_table(table))
```

## Core API

The core mirrors the npm API with Python function names. Returned models use
ordinary dictionaries and lists, with `TypedDict` definitions and `py.typed`.
Field names match the npm model, including caption `contentRange`.

- `parse_table(source, *, multiline=False, rowspan=False, headerless=False,
  multibody=True, autolabel=True)` returns a `Table` or `None`. It reads only a
  leading table and stops at the first rejected line.
- `stringify_table(table)` writes LF line endings without a trailing newline.
  It accepts a parsed `Table` or a `WriteTable`. It raises `TypeError` for invalid
  Python types and `ValueError` for invalid grids or unrepresentable Markdown.
- `cell_bounds(line)` returns UTF-16 pipe boundaries outside escapes and code spans.
- `expand_section(section)` returns a rectangular grid, preserving each source
  cell as `origin`. Span copies have `inherited=True`; holes are `None`.
- `defaults` is a read-only mapping of the five options.

See the [shared API reference](https://github.com/Murlors/multimd-table/blob/main/docs/api.md) for grammar and writer semantics.

## Incremental scanning

Use a context manager, or call the idempotent `dispose()` in `finally`.
`finish()` returns an independent snapshot and permits further input.

```python
from multimd_table import TableScanner

with TableScanner(rowspan=True) as scanner:
    scanner.push("A|B", 0)
    scanner.push("-|-", 4)
    scanner.push("one|two", 8)
    table = scanner.finish()
```

`accepted`, `committed` and `finished` have the same meanings as in JavaScript.
`scanner.options` is a mutable dictionary, affecting subsequent pushes and snapshots.
Disposal releases native state and retained input. Existing snapshots remain valid;
subsequent `push()` and `finish()` raise `RuntimeError`.

## Source positions

All ranges and scanner offsets count **UTF-16 code units**, including isolated
surrogates, matching the npm model. They are not Python string indices.
For a source range, extract its text without changing surrogate content:

```python
raw = source.encode("utf-16-le", "surrogatepass")
value = raw[span["start"] * 2:span["end"] * 2].decode("utf-16-le", "surrogatepass")
```

Scanner offsets must be nonnegative JavaScript-safe integers. Gaps, repeated offsets
and offsets above 32 bits are preserved. Local table coordinates remain 32-bit.

## Ecosystem scope

| Library         | Scope                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| markdown-it-py  | First planned adapter; block tokens and cell parsing stay with the host. |
| Python-Markdown | Later adapter, using its extension and tree-processing API.              |
| Mistune         | Later adapter, using its own token and renderer API.                     |

This package currently provides core functions only. These adapters are planned,
not implemented or certified compatible. No Markdown host, pandas or Pydantic is a
runtime dependency.

## Development

Rust and a matching CPython development environment are required to build from source.
Repository contract checks also require the `wasm32-unknown-unknown` Rust target.
From the repository root, install workspace dependencies with `vp install`.
Use a build environment with maturin and mypy:

```sh
python -m venv .performance/python-build
# Activate the environment using its platform-specific activation script.
python -m pip install "maturin>=1.15,<2" mypy
vp run verify:python
```

The command prepares the shared WASM core, then verifies the frozen compatibility hashes before exporting 2,130 complete
parser/writer models. It builds a wheel and source archive, audits wheel contents,
and creates a separate consumer environment. Both wheel installation and an isolated
PEP 517 source build must pass the complete model, scanner, Unicode writer and type
checks. The consumer imports the installed extension without source-path injection.
Maturin and mypy are development tools, not runtime dependencies.

Results stay under `.performance/python-acceptance/`. Use a fresh output directory
for another run or a different CPython interpreter:

```sh
vp run verify:python --python /path/to/python3.11 --out .performance/python-acceptance-311
```

For focused checks after installing the wheel, set `MULTIMD_VECTORS` to the absolute
path of `.performance/python/vectors.json` and run:

```sh
python -m unittest discover -s packages/python/tests -v
python -m mypy --strict packages/python/tests/typing_consumer.py
```

CI runs the same acceptance script for CPython 3.11 and 3.14 on Linux, macOS and Windows.
This matrix validates the version endpoints; it does not produce wheels for every
intermediate Python version or every architecture. The package is not published to PyPI.

Python source lives in `src/multimd_table/`; the PyO3 bridge lives in `rust/src/`.
The bridge uses its own Cargo project and lockfile in `rust/`. Its dependencies and
release profile do not alter the npm WASM build. Wheels target the matching CPython
minor version and platform; they do not bundle Python, Rust, maturin or a WASM runtime.
