# Rust shared core

The package uses one Rust parser/writer through WASM. Public npm
entry points retain synchronous calls and TypeScript models. The former TS
parser/writer and dual-backend benchmark tools have been removed. Python and Go
bindings remain integration probes rather than published language packages.

The npm package ships one standalone `core.wasm`. Module import loads and
initializes it automatically; Node/Bun read the installed file and browsers fetch
the module-relative URL. Public calls remain synchronous after that asynchronous
ESM initialization. Release builds strip symbol metadata and use speed-oriented
optimization. Bridge modules are minified by the same Vite+ pack pipeline as the
public entries. Caption identifier normalization retains the standard Unicode
lowercase implementation.

Browser and Node/Bun call the same WASM build; Python and Go integration probes
call the native build through its C ABI. `expandSection` remains a small
host-side utility so JavaScript `origin` references retain object identity.

## Development and validation

Bun/Node dependencies and Rust with the `wasm32-unknown-unknown` target are
required. Native cross-language checks additionally need Python 3 and Go with
cgo/C compiler support. Scripts do not install global tools; Cargo uses the
checked-in lockfile with `--locked`.

```sh
# Rust, transport, package tests and production build.
vp run verify
# Actual tarball in isolated Node/Bun/TypeScript consumers and browser bundles.
vp run verify:package
# Frozen contracts, then the same complete models in Python and Go.
vp run core:check

# Maintained end-to-end performance suite; use fresh result paths.
vp run bench --out .performance/baseline
vp run bench --out .performance/candidate
vp run bench:compare .performance/baseline-node.json .performance/candidate-node.json

# Separate diagnostic stages: transport, Rust execution and object construction.
vp run core:profile --only plain-1000 --out .performance/shared-core/profile
vp run core:profile --writer --only plain-1000 --out .performance/shared-core/writer-profile
vp run core:profile --native-only --only plain-1000 --out .performance/shared-core/native-profile

# Optional Python observation, after core:check generates the corpus.
python3 crates/core/bindings/benchmark_python.py \
  .performance/shared-core/performance-fixtures.json \
  .performance/shared-core/python-observation.json
```

Measurements and generated vectors stay in ignored `.performance/`; compiled
Rust artifacts stay in ignored `target/`. The maintained benchmark compares
saved reports for the same corpus/environment rather than retaining an old
parser implementation. See [the baseline guide](../../docs/baselines.md).

## What is checked

- Ten transport tests independently specify the wire format, truncation,
  little-endian UTF-16, surrogate handling, source lookup and buffer ownership.
- The package tests cover grammar, all three adapters, React, MDX, source
  positions, writing, independent snapshots and deterministic native cleanup.
- `test/fixtures/core-contracts.json` freezes results obtained from the former TS
  implementation before its removal. It contains reviewed SHA-256 summaries of
  2,130 complete parser/writer cases in groups of at most 100, seven additional
  Unicode writer boundaries, and incremental scanner contracts. Object keys are
  sorted before hashing; arrays, values and UTF-16 ranges remain significant.
  Group failures identify the first/last case IDs. This is a regression contract,
  not an automatically regenerated snapshot of the current implementation.
- `core:check` verifies those frozen contracts before exporting the same complete
  models and successful writer results to the Python and Go native probes.
- Thirteen Rust tests cover snapshots, rejection, mixed line endings, truncated or
  unaligned writer requests, owned native result lifetimes and writer syntax
  boundaries (HTML, autolinks, Unicode whitespace, fences and captions).
- `check:package` generates `/.performance/package-browser/index.html` from the
  actual installed tarball. Serve the repository over local HTTP to validate
  synchronous APIs, all adapters, Unicode, offsets and a real module Worker.

Full CommonMark interpretation of cell content remains with the host Markdown
parser.

## Boundary design

The relevant entry points are:

| File                                                   | Responsibility                                                                |
| ------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `src/core.rs`, `src/writer.rs`                         | Markdown grammar, core model and canonical writing                            |
| `src/wire.rs`, `src/json.rs`                           | Rust-side binary/native JSON transport                                        |
| `src/lib.rs`                                           | Operational C ABI and owned input/result/scanner handles                      |
| `src/profile.rs`                                       | Borrowed handles used by stage diagnostics; re-exported to preserve ABI paths |
| project `src/internal/wire.mjs`                        | Binary reads/writes and eager JS model construction                           |
| project `src/internal/wasm.mjs`                        | WASM calls, resource ownership and diagnostic lifetimes                       |
| project `src/internal/backend.ts`                      | Embedded-module loading and host UTF-16 copying                               |
| project `src/types.ts`, `src/core.ts`, `src/writer.ts` | Public types and synchronous entry points                                     |
| `bindings/*.mjs`                                       | Thin raw-WASM loaders/re-exports used by diagnostics                          |

The JS codec is independent of a WASM instance. It reads a supplied ArrayBuffer
and follows table → section → row → cell field order in one sequential decoder;
it has no Markdown grammar or resource release side effects. The runtime binding
distinguishes reading a borrowed
response from reading and releasing an owned response. Both paths share writer
error decoding and trailing-byte validation.

Source strings enter Rust as UTF-16 units. The core uses the ECMAScript whitespace
set, and ranges count UTF-16 units in every language. A normal Rust UTF-8 `String`
conversion would lose isolated surrogates. The scanner owns accepted incremental
lines; whole-string parsing borrows the UTF-16 input for the duration of the call.
The internal model stores source coordinates, with cells in a single contiguous
arena and single-line segments inline. It does not duplicate cell text. Native
JSON output streams values from those segments; JS slices its original strings.
Returned host models still contain all values, arrays and ranges as before.
Physical rows index a shared boundary arena. A small inline scratch buffer scans
ordinary rows without allocating; wide rows spill into a temporary vector.

The writer's fixed HTML, autolink, container, fence and caption checks scan those
UTF-16 units directly in `src/writer/syntax.rs`. They preserve the existing
escaping and rejection rules without a regex engine, runtime pattern compilation
or shadow-text allocation. They only recognize the boundaries needed for safe
table serialization; full cell Markdown interpretation stays with the host.

Python and Go receive UTF-8 JSON with isolated surrogates explicitly escaped.
JS receives a compact binary structure containing source segments and derives
cell strings by slicing the original source at those coordinates. The scanner
binding retains accepted physical lines for this purpose. No Markdown grammar is
duplicated in the binding. Transport and complete object construction are inside
the public API timer. Writer requests use a small checked little-endian binary
format; writer results preserve UTF-16.
The transport protocol is private and has no ABI stability promise.
Aligned little-endian writer requests borrow their UTF-16 text during the call;
unaligned or big-endian inputs use the checked copying path. The result remains
owned. Node/Bun copy large strings directly into WASM memory with the standard
Buffer UTF-16 writer; small rows and browsers use the scalar copy. This is host
transport for the same WASM core, not a different parser backend. Long result
strings use strict UTF-16 TextDecoder decoding, preserving BOM; isolated
surrogates use the original code-unit fallback rather than replacement characters.

WASM scanners allocate native state lazily and expose idempotent `dispose()`.
All three adapters release their own scanners on successful and failed parsing;
remark also releases active scanners when nested parsing throws. Direct users
must dispose their scanner after the last snapshot. FinalizationRegistry is only
a fallback. Disposing one parser never releases another caller's scanner.

The binding assigns monotonically increasing table-local positions to accepted
lines, so WASM coordinates stay within its address space. Source strings are
resolved through those positions; model ranges are mapped back to the original
nonnegative JS safe-integer offsets when necessary. Large, repeated and unordered
host offsets are covered by frozen TS contracts. Normal contiguous LF inputs skip
the range-remapping pass. Changing scanner options updates subsequent pushes and
snapshot materialization. The private wire still uses 32-bit counts and local
coordinates; it does not truncate public document offsets.

Python currently uses standard-library ctypes and a local shared library, not a
built wheel or a PyO3 extension. Go proves cgo parsing and lossless model transport;
it does not yet expose a writer or a Markdown-host plugin. Go `Text` holds UTF-16
units, while `Text.String()` is a display conversion that replaces invalid
surrogates. Distribution, cross-compilation and native JS addons are untested.

## Diagnostic measurements

`bench` and `bench:compare` are the maintained end-to-end baseline described in
[the baseline guide](../../docs/baselines.md). Diagnostic reports include the
current public Rust/WASM call as `publicCall`; they do not load a TS backend.

`core:profile` is diagnostic rather than the release throughput benchmark.
It uses one fresh process per fixture/runtime, three rounds in alternating stage
order, 150 ms warmup per stage/round, and three calibrated 20 ms batches per round.
`input` includes allocation/copy/free. `scan`, `model`, `encode`, `rust` and
`rustWire` use preloaded input/scanner/model handles as appropriate, and free each
new result. `decode` reuses immutable wire bytes but builds complete JS objects on
every call. `full` includes transport, Rust execution and output objects, with
option bits prepared outside timing. The public-call benchmark also includes
option processing. Each stage has different allocation/cache/GC behavior, so its
standalone time is not an exactly additive percentage of `full`.

With `--writer`, `input` encodes the host model, `copy` allocates/copies/frees a
prepared request, and `decodeInput` decodes/frees a Rust request model. `rust`
writes a preloaded model, while `rustWire` includes request decoding, writing and
response encoding. `decode` reconstructs the result string from fixed response
bytes and `full` invokes the actual complete writer binding. Preloaded request
bytes remain alive until every borrowed Rust model is freed. Native writer
profiling is not implemented; `--native-only` applies to parser profiling.

The native probe calls the same Rust scanning/model/encoding functions directly,
using a precompiled release executable and identical UTF-16 fixtures. It warms
each stage for 200 ms and records seven batches calibrated to at least 5 ms (up to
65,536 operations). An additional untimed call counts allocations and requested
allocation bytes, including reallocations; these are not peak or retained memory.
Native profiling excludes any Python/Go/JS bridge and is a diagnostic comparison,
not an end-to-end native binding benchmark. Neither profile measures cold startup.

Python's observation uses one process, 500 ms warmup and seven batches targeting
40 ms. It includes UTF-16 conversion, native execution, output serialization and
Python objects. There is no pure-Python baseline, so these values cannot support
a Python speedup claim. Go is not performance-benchmarked in this stage.
