# multimd-table for Python

Parse, edit and write MultiMarkdown tables with merged cells, multiline content
and source ranges. Python calls the same Rust grammar and writer as the npm package.

Requires CPython 3.11 or newer.
The core has no Python runtime dependencies. An optional markdown-it-py adapter
renders tables within complete Markdown documents.

Install into a virtual environment:

```sh
python -m pip install multimd-table
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

## Render Markdown

Install the optional host:

```sh
python -m pip install "multimd-table[markdown-it]"
```

```python
from markdown_it import MarkdownIt
from multimd_table.markdown_it import multimd_table_plugin

md = MarkdownIt("commonmark").enable("table").use(multimd_table_plugin, rowspan=True)
html = md.render("# Inventory\n\nA|B\n-|-\nmerged||\n^^||")
```

`multimd_table_plugin(md, **options)` accepts the five core options.
It replaces the host's `table` rule while preserving its enabled state.
The CommonMark preset requires `.enable("table")`; disabling `table` disables this adapter too.
Cells and captions use the host's inline rules, references, renderer and HTML policy.
Multiline block cells use the host's block parser and the document's shared environment.
Token maps contain document line numbers; core model ranges remain UTF-16 offsets.

The [Notebook example](https://github.com/Murlors/multimd-table/blob/main/packages/python/examples/tables.ipynb)
parses a table, edits it, writes Markdown and displays merged cells as HTML output.
Install the package with the `markdown-it` extra in the notebook kernel's environment.
This example does not change Jupyter's Markdown-cell renderer or configure nbconvert.

## Ecosystem scope

| Library         | Scope                                                                   |
| --------------- | ----------------------------------------------------------------------- |
| markdown-it-py  | Supported versions 3.x and 4.x, installed with the `markdown-it` extra. |
| Python-Markdown | Not implemented; future work depends on integration requests.           |
| Mistune         | Not implemented; nbconvert integration requires separate validation.    |

The base installation does not depend on a Markdown host, Jupyter, pandas or Pydantic.
There is no JupyterLab frontend extension in this package.

## Development

Rust and a matching CPython development environment are required to build from source.
Repository contract checks also require the `wasm32-unknown-unknown` Rust target.
From the repository root, install workspace dependencies with `vp install`.
Install the checkout with `python -m pip install "./packages/python[markdown-it]"`.
Use a build environment with maturin and mypy:

```sh
python -m venv .performance/python-build
# Activate the environment using its platform-specific activation script.
python -m pip install "maturin>=1.15,<2" mypy
vp run verify:python
```

The command prepares the shared WASM core and verifies the frozen compatibility hashes.
It exports 2,130 parser/writer models and 114 hand-written adapter HTML cases,
including all 32 option combinations. It builds a wheel and source archive and audits their contents.
Separate core and adapter consumers verify both wheel and isolated PEP 517 source installations.
Checks cover complete models, scanner lifecycle, Unicode, host integration and installed types.
Consumers import the installed package without source-path injection.
Maturin and mypy are development tools, not runtime dependencies.

Results stay under `.performance/python-acceptance/`. Use a fresh output directory
for another run or a different CPython interpreter:

```sh
vp run verify:python --python /path/to/python3.11 --out .performance/python-acceptance-311
```

For focused checks after installing the wheel, set `MULTIMD_VECTORS` to the absolute
path of `.performance/python/vectors.json` and run:

```sh
python -m unittest discover -s packages/python/tests -p test_core.py -v
python -m mypy --strict packages/python/tests/typing_consumer.py
```

With the `markdown-it` extra installed, run `test_markdown_it.py` and
`typing_markdown_it.py` the same way. To execute the Notebook in the current Python environment:

```sh
python -m pip install nbclient ipykernel
python tooling/check-notebook.py --out .performance/notebook-acceptance
```

The runner uses the current interpreter without registering a global kernel.
It checks the displayed HTML and saves the executed notebook under the output directory.

CI runs the same acceptance script for CPython 3.11 and 3.14 on Linux, macOS and Windows.
This matrix validates the version endpoints; it does not produce wheels for every
intermediate Python version or every architecture.

## Release

The **Python release** workflow builds CPython 3.11–3.14 wheels for Linux
(manylinux2014), Windows and macOS, each on x86-64 and ARM64: 24 wheels per release.
Linux and Windows ARM64 builds use native `ubuntu-24.04-arm` and `windows-11-arm` runners.
Each wheel is installed and tested before upload. A separate job validates source installation and the Notebook.
Manual workflow runs build and validate artifacts without publishing.
The `python-v<version>` tag must match both Python package versions and triggers PyPI publishing.
JavaScript versions and `v*` tags are independent.

Configure a PyPI Trusted Publisher for owner `Murlors`, repository `multimd-table`,
workflow `python-release.yml` and environment `pypi` before the first release.
PyPI permits a pending publisher for a new project named `multimd-table`.
Sign in to [PyPI account publishing settings](https://pypi.org/manage/account/publishing/)
and add a GitHub publisher with those values. Use the workflow filename without a directory prefix.
Your account needs a verified email and two-factor authentication.
The first successful upload creates the project; no long-lived API token is needed.
The publish job downloads only validated distributions and checks their metadata with Twine.
After publication, verify the registry files and install the package in a fresh consumer environment.

32-bit ARM, Alpine/musl, PyPy and free-threaded CPython wheels are outside this release matrix.
Other supported CPython source installations require Rust and Python development headers.

Python source lives in `src/multimd_table/`; the PyO3 bridge lives in `rust/src/`.
The bridge uses its own Cargo project and lockfile in `rust/`. Its dependencies and
release profile do not alter the npm WASM build. Wheels target the matching CPython
minor version and platform; they do not bundle Python, Rust, maturin or a WASM runtime.
