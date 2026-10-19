# Rust shared core

The development package uses one Rust parser/writer through WASM. Public npm
entry points retain synchronous calls and TypeScript models. The former TS
parser/writer and dual-backend benchmark tools have been removed. Publishing
and application deployment are separate steps and have not been performed.

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
bun run check
# Actual tarball in isolated Node/Bun/TypeScript consumers and browser bundles.
bun run check:package
# Frozen contracts, then the same complete models in Python and Go.
bun run core:check

# Maintained end-to-end performance suite; use fresh result paths.
bun run bench --out .performance/baseline
bun run bench --out .performance/candidate
bun run bench:compare .performance/baseline-node.json .performance/candidate-node.json

# Separate diagnostic stages: transport, Rust execution and object construction.
bun run core:profile --only plain-1000 --out .performance/shared-core/profile
bun run core:profile --writer --only plain-1000 --out .performance/shared-core/writer-profile
bun run core:profile --native-only --only plain-1000 --out .performance/shared-core/native-profile

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
- The 311 package tests cover grammar, all three adapters, React, MDX, source
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
- Eight Rust tests cover snapshots, rejection, mixed line endings, truncated or
  unaligned writer requests, invalid lengths and owned native result lifetimes.
- `check:package` generates `/.performance/package-browser/index.html` from the
  actual installed tarball. Serve the repository over local HTTP to validate
  synchronous APIs, all adapters, Unicode, offsets and a real module Worker.

The dated evaluation sections below describe historical implementations and
measurements. Their TS comparisons and retired experimental commands are a
record of those runs; current development uses the commands above. Full
CommonMark interpretation of cell content remains with the host Markdown parser.

## Boundary design

The relevant entry points are:

| File | Responsibility |
| --- | --- |
| `src/core.rs`, `src/writer.rs` | Markdown grammar, core model and canonical writing |
| `src/wire.rs`, `src/json.rs` | Rust-side binary/native JSON transport |
| `src/lib.rs` | Operational C ABI and owned input/result/scanner handles |
| `src/profile.rs` | Borrowed handles used by stage diagnostics; re-exported to preserve ABI paths |
| project `src/internal/wire.mjs` | Binary reads/writes and eager JS model construction |
| project `src/internal/wasm.mjs` | WASM calls, resource ownership and diagnostic lifetimes |
| project `src/internal/backend.ts` | Embedded-module loading and host UTF-16 copying |
| project `src/types.ts`, `src/core.ts`, `src/writer.ts` | Public types and synchronous entry points |
| `bindings/*.mjs` | Thin raw-WASM loaders/re-exports used by diagnostics |

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

Python and Go receive UTF-8 JSON with isolated surrogates explicitly escaped.
JS receives a compact binary structure containing source segments and derives
cell strings by slicing the original source at those coordinates. The scanner
binding retains accepted physical lines for this purpose. No Markdown grammar is
duplicated in the binding. Transport and complete object construction are inside
the public API timer. Full-text binary and JSON JS responses were explored before
this source-referencing transport; measurements use only the retained transport.
Writer requests
use a small checked little-endian binary format; writer results preserve UTF-16.
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

## Measurement interpretation

Full TS/WASM comparisons use three new processes per workload/backend/runtime,
1,000 ms warmup and seven calibrated batches targeting 40 ms. Input conversion,
complete output objects and scanner disposal are inside the timer. Hosts are reused
as in the maintained baseline; fixture preparation and output checks are outside.
Version metadata, WASM artifact hash/size, all raw batches, module initialization
and first-call observations are retained in JSON. Initialization observations do
not include process startup and are not cold filesystem-cache measurements.
`--warmup-ms` and `--trials` accept positive integers and are recorded in the
report configuration. Defaults remain 1,000 ms and three processes (100 ms and
one process with `--quick`). The same warmup is forwarded to every backend worker;
longer warmup reports must be compared within that run, not directly against
timings from a different configuration.

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

Performance acceptance must be based on complete calls and actual host rendering.
Passing the compatibility suite alone is not grounds to replace the current npm
core. A slow WASM prototype is evidence about this bridge and implementation, not
proof that every possible Rust/native/WASM design must be slow.

## Initial result: 2026-10-19

Apple M4 / macOS arm64, Node 24.21.0, Bun 1.4.3, Rust 1.93.0. The full paired run
used 204 fresh measurement processes and 1,428 timing batches. Values below are
milliseconds per complete call on Node, using the median of process medians.

| Workload | Existing TS | Rust/WASM | Time ratio |
| --- | ---: | ---: | ---: |
| Plain 10 rows | 0.002465 | 0.005072 | 2.06x |
| Plain 1,000 rows | 0.193845 | 0.404828 | 2.09x |
| Plain 5,000 rows | 1.062343 | 2.296879 | 2.16x |
| Rich 1,000 rows | 0.327717 | 0.438257 | 1.34x |
| Multiline 500 rows | 0.253648 | 0.237745 | 0.94x |
| Marked / plain 1,000 | 2.012415 | 2.408282 | 1.20x |
| remark / plain 1,000 | 28.381979 | 30.225771 | 1.06x |
| markdown-it / plain 1,000 | 5.334203 | 5.652768 | 1.06x |

Ratios above 1 are slower. Bun's plain core cases were 1.68–1.92x slower;
its complete Marked renders were 1.08–1.23x slower, while remark and markdown-it
were closer to the existing implementation. These are observations of this
prototype on one machine, not general Rust/WASM guarantees. Small differences
such as the multiline result require replication before being treated as wins.

The initial full run's WASM artifact was 946,360 bytes before compression, including the writer and
its regex implementation. Package-size optimization has not been performed.
Compatibility checks passed, but the ordinary-table slowdown is repeatable:
Node plain-1,000 process medians were 0.192–0.195 ms for TS and 0.404–0.406 ms for
WASM. This candidate should not replace the npm core under a performance-first
acceptance criterion. Further work should isolate Rust model construction and
host-boundary costs before committing to a production migration.

Raw local reports are generated at `.performance/shared-core/evaluation-compact-20261019.json`
and the accompanying `.md`. No code or binary was published by this evaluation.

After the Unicode writer correction, before the parser optimizations below, the three directly relevant workloads were
repeated with the same full sampling profile (36 fresh processes). The current
artifact was 948,763 bytes; its hashes and raw timings are in
`.performance/shared-core/evaluation-final-20261019.json`:

| Runtime | Workload | Existing TS ms | Current Rust/WASM ms | Time ratio |
| --- | --- | ---: | ---: | ---: |
| Node | Plain 1,000 rows | 0.191353 | 0.396898 | 2.07x |
| Node | Write plain 1,000 | 1.413051 | 1.479937 | 1.05x |
| Node | Write rich 1,000 | 1.403204 | 1.533215 | 1.09x |
| Bun | Plain 1,000 rows | 0.242662 | 0.407116 | 1.68x |
| Bun | Write plain 1,000 | 0.877661 | 1.182936 | 1.35x |
| Bun | Write rich 1,000 | 0.903494 | 1.252921 | 1.39x |

The extra compatibility fix did not resolve the observed throughput regression.

The pre-optimization Python 3.14.7/ctypes observation returned a complete 1,000-row plain
model in about 5.60 ms and wrote that model in about 4.95 ms. These are single-process
absolute observations, not comparisons with a Python implementation. Raw data and
the native library hash are in `.performance/shared-core/python-final-20261019.json`.

## Bottleneck analysis and parser optimization: 2026-10-19

The initial Node profile of plain 1,000 rows measured 0.189 ms for the complete JS
parser, versus 0.266 ms for Rust/WASM scanning and model construction alone. Input
copy took 0.016 ms, compact encoding 0.023 ms and JS object construction 0.088 ms;
the full bridge took 0.404 ms. Native Rust also spent about 0.201 ms in modeling
and 0.302 ms in the complete core, without a language bridge. The original model
construction was the main avoidable cost; WASM crossing alone did not explain it.

The retained changes are:

- Store cell text as source segments instead of allocating text that the JS
  binding immediately discards. Native JSON streams the same source segments.
- Inline the first segment and keep cells in a contiguous arena. Remove temporary
  placeholder cells and the second pass moving them into per-row vectors.
- Track inherited cells only when rowspan is enabled. Check multiline `^^`
  semantics without allocating joined text, with explicit regression coverage.
- Borrow whole-string input during scanning, keep incremental scanner ownership,
  and reserve pipe-boundary space including sentinels in the common case.
- Decode single-segment cells directly into their complete JS model, avoiding the
  general multiline loop. Source ranges and values remain eager and fully checked
  by the differential suite.

An aligned Uint32Array wire-reader variant did not improve both runtimes
consistently, so it was discarded; the existing DataView protocol remains.
The final host adapters use the same minification/name-preservation settings as
the production comparator. Initial experiment adapter bundles were unminified.

The final full run again used 204 fresh processes and 1,428 batches. Ratios compare
complete Rust/WASM calls with existing JS calls in the same run; below 1 is faster.

| Parse workload | Node JS ms | Node Rust/WASM ms | Node ratio | Bun ratio |
| --- | ---: | ---: | ---: | ---: |
| Plain 10 rows | 0.002464 | 0.002612 | 1.06x | 1.07x |
| Plain 1,000 rows | 0.194746 | 0.205248 | 1.05x | 0.94x |
| Plain 5,000 rows | 1.094375 | 1.364436 | 1.25x | 1.03x |
| Rich 1,000 rows | 0.332289 | 0.260851 | 0.79x | 0.77x |
| Multiline 500 rows | 0.255013 | 0.171759 | 0.67x | 0.77x |
| Escaped 1,000 rows | 0.291494 | 0.248707 | 0.85x | 0.78x |
| Wide 128 columns | 0.402382 | 0.436782 | 1.09x | 0.94x |
| Unmatched ticks | 0.034651 | 0.024584 | 0.71x | 0.89x |
| Invalid 5,000 rows | 0.485552 | 0.451542 | 0.93x | 0.89x |

All six complete adapter renders were 0.97–1.09x on Node and 0.99–1.05x on Bun.
Writer throughput remains 1.04–1.08x on Node and 1.32–1.33x on Bun; this round
optimized the parsing path, not writer internals. The Node large plain table and
Bun writer are still material gaps, so this is evidence that a shared Rust core
can approach JS speed, not that every path already matches it. The diagnostic
profile is intended to guide subsequent work without hiding the remaining full
call costs behind a core-only benchmark. No public backend was changed.

The final WASM artifact is 951,491 bytes, including diagnostic exports and the
unchanged writer/regex implementation. Raw results and artifact fingerprints:

- `.performance/shared-core/evaluation-optimized-20261019.json`: complete calls,
  writer, and all host renders, with per-process medians and cold observations.
- `.performance/shared-core/profile-before-20261019.json` and
  `profile-optimized-20261019.json`: isolated WASM/JS stages before and after.
- `.performance/shared-core/profile-native-before-20261019.json` and
  `profile-native-optimized-20261019.json`: native stages and allocation counts.

The final Node isolated plain-1,000 profile puts scanning/modeling at 0.092 ms,
input transfer at 0.015 ms, encoding at 0.025 ms and JS reconstruction at 0.083 ms.
Core modeling fell from 0.185 to 0.037 ms, while JS reconstruction changed much
less. The remaining bridge/object work is now comparable to the core rather than
being negligible. Native complete-core time fell from 0.302 to 0.075 ms; its
allocation observation fell from 12,052 to 1,019 allocations per parse (including
reallocations), with cumulative requested bytes falling from 1,867,062 to 629,120.
These native counts exclude serialization and host objects, and are not peak RSS.

A separate Node CPU sample of the 5,000-row workload recorded about 25.5% in JS
model reconstruction, 8.8% in input handling and 8.0% in Rust compact encoding.
GC occupied about 15.9%, versus 15.3% in the JS sample; GC alone is not established
as the cause of the remaining gap. These are one-process sample shares including
warmup and initialization, not additive per-operation timings or a replacement
for the full paired benchmark. Raw profiles are `large-wasm.cpuprofile` and
`large-js.cpuprofile` under `.performance/shared-core/`. They were produced with
the retired dual-backend runner; the current diagnostic entry is `core:profile`.

The repeated Python observation still takes about 5.20 ms to return a complete
plain 1,000-row model and about 5.05 ms to write it. The ctypes/JSON prototype does
not inherit the native-core speed directly; native JSON encoding and Python
conversion/object creation remain inside that complete call and are not isolated
by the WASM probes. Raw observations and the current native library hash are in
`.performance/shared-core/python-optimized-20261019.json`. A production Python
binding still requires its own transport/performance evaluation.

## Large-table and writer follow-up: 2026-10-19

Writer profiling isolated a large cost in the previous JS response decoder:
plain 1,000-row output took about 0.472 ms to reconstruct on Bun, in addition to
0.704 ms writing a preloaded Rust model. The retained changes are:

- Borrow ordinary inline cell text, avoid repeated normalization/splitting and
  cloning, and build regex shadow bytes only when HTML needs them. Code-span
  successors use a compact indexed vector; the common two-run span avoids maps.
- Borrow aligned little-endian request text instead of allocating each cell's
  UTF-16 value. Unaligned requests retain the checked copy path. Bulk response
  encoding copies little-endian UTF-16 in one operation, with a big-endian fallback.
- Decode long valid UTF-16 strings with strict TextDecoder and preserve invalid
  surrogate units through the previous fallback. Long Unicode fixtures and the
  browser check exercise both successful decoding and fallback followed by reuse.
- Copy large Node/Bun inputs directly into WASM memory through Buffer.write,
  avoiding an intermediate Buffer payload. The browser still uses the same Rust
  core with scalar input transport. Small rows avoid Buffer overhead.
- Store scanner boundaries in a shared arena with row indices, using an inline
  scan scratch buffer for short rows. Reserve compact output capacity up front.

Default-field wire compression was also measured. Despite smaller responses, it
did not yield a stable speed benefit and some wide-table runs regressed. It was
discarded; the existing fixed-field compact protocol is retained. Storing the
inline boundary array in every physical row was also superseded by the arena so
that moving rows does not move those arrays.

The final full run used 204 fresh processes and 1,428 batches, with the same corpus
and eager complete API results. Apple M4, Node 24.21.0, Bun 1.4.3, Rust 1.93.0:

| Runtime / workload | Existing JS ms | Rust/WASM ms | Time ratio |
| --- | ---: | ---: | ---: |
| Node / parse plain 1,000 | 0.210637 | 0.198774 | 0.94x |
| Node / parse plain 5,000 | 1.235797 | 1.368338 | 1.11x |
| Node / write plain 1,000 | 1.513588 | 0.589389 | 0.39x |
| Node / write rich 1,000 | 1.460264 | 0.666894 | 0.46x |
| Bun / parse plain 1,000 | 0.266143 | 0.218214 | 0.82x |
| Bun / parse plain 5,000 | 1.189216 | 1.104691 | 0.93x |
| Bun / write plain 1,000 | 1.030838 | 0.548040 | 0.53x |
| Bun / write rich 1,000 | 1.067727 | 0.598164 | 0.56x |

The remaining Node plain-5,000 gap is about 11% in the full run, and about 15% in
a separate targeted full-profile repeat. The previous complete run reported 25%.
Absolute times vary between runs, including the JS comparator, so the paired
ratios are more informative than subtracting absolute times from different runs.
This gap is reduced, not eliminated. Small/wide Node cases remain about 10–11%
slower. Complete host rendering remains runtime-dependent: 1.03–1.10x on Node and
0.91–1.12x on Bun. This is not a universal speedup or a public backend migration.

The final writer diagnostic puts Bun plain-1,000 Rust writing at 0.308 ms and
result decoding at 0.027 ms, versus 0.704 and 0.472 ms before this follow-up.
Node plain-5,000 input transfer is about 0.005 ms rather than the preceding
0.124 ms. Its remaining standalone costs include about 0.462 ms in the Rust core,
0.144 ms in encoding, and 0.466 ms reconstructing complete JS objects. Standalone
stages still must not be treated as an exactly additive decomposition.

Native plain-5,000 core parsing measured 0.333 ms versus the previous 0.364 ms.
Its allocation count fell from 5,022 to 34, but cumulative requested bytes rose
from 3,682,688 to 3,886,808 because arenas grow geometrically. Allocation count is
not peak memory. Native plain-1,000 went from 1,019 to 28 allocations and about
0.075 to 0.068 ms. Wide native parsing did not improve (0.117 to 0.127 ms); fewer
allocations do not guarantee faster execution in every case.

All 305 redirected tests, 2,130 cross-language model/writer comparisons, seven
additional Unicode writer boundary cases, eight Rust tests and the browser bulk
UTF-16/scanner checks passed. Type checking and Rust formatting passed. The final
WASM artifact is 954,853 bytes. No dependency or npm backend was changed.

Raw local reports and fingerprints are under `.performance/shared-core/`:

- `evaluation-refined-20261019.json`: final full benchmark.
- `evaluation-flat-bounds-20261019.json`: separate targeted Node large-table run.
- `profile-refined-20261019.json`: final parsing stage timings.
- `writer-before-20261019.json` and `writer-refined-20261019.json`: writer stages.
- `native-refined-20261019.json`: final native timings and allocation observations.
- `python-refined-20261019.json`: ctypes/JSON observation. Plain-1,000 parsing
  still takes about 5.34 ms and writing about 4.47 ms; native-core improvements
  cannot be extrapolated to Python conversion/object costs.

## Result encoding and object construction: 2026-10-19

Changes are judged on correctness, architectural clarity and complete-call cost
together. A clearer ownership boundary or less duplicated protocol logic can
justify a measured performance tradeoff. A neutral benchmark alone is not a
reason to reject a useful structural change. Conversely, lower isolated encode
time does not justify additional special cases without a clear overall benefit.
Prefer direct data flow, cohesive functions and few concepts. Add an abstraction
when it removes real duplication or clarifies ownership; add a fast path when
its complete-call benefit justifies the extra code and maintenance cost.

A candidate batched fixed-size metadata writes in Rust while keeping the existing
compact protocol. It cut standalone Node plain-5,000 encoding from about 0.144 ms
to 0.068 ms. Nine shared corpus responses were also checked byte-for-byte against
the previous encoder. However, the complete large-table call did not show a
reliable improvement, so this encoder candidate was discarded too. The previous
Rust encoder and JS decoder are both retained.
The candidate's single-segment fast path duplicated the common cell header fields,
so it did not establish a structural improvement that would justify the observed
large-table tradeoff. Fixed-offset JS decoding also repeated protocol field offsets.

Several JS alternatives were compared against frozen bindings and binaries in
rotating fresh processes: fixed-offset record reads, direct whole-input string
slices, a separate cell-construction method, deferred range construction and
different object field order, growing packed arrays, and prefilled fixed-size
arrays. Some improved individual wide-table runs, but none consistently improved
the 5,000-row case without regressions elsewhere. They were discarded. A quick
V8 diagnostic also showed allocation-site tenuring changes causing deoptimization;
that observation is not a measurement of the steady-state GC share.
The separate cell method was tested together with other decoder changes; these
measurements do not independently establish the cost or value of extracting a
cohesive cell decoder. A future structural extraction should be assessed separately.

The benchmark now accepts a complete historical binding/binary snapshot with
`--previous`. This avoids attributing changes in machine load or the JS comparator
between separate runs to an optimization. It still reports complete calls and
all process medians; standalone encode/decode probes are diagnostic only.

The 270-process full report (`evaluation-output-final-20261019.json`) is preserved
but is too noisy to establish an end-to-end speedup. Node TS plain-5,000 process
medians were 2.808, 3.959 and 1.230 ms. Even the old WASM invalid-input control,
whose response is just a null marker, ranged from 0.332 to 2.970 ms. The apparent
large-table speedup in that full report must not be attributed to batching
metadata writes. A separate targeted Node repeat includes this unchanged invalid
input control as well as plain-1,000, plain-5,000 and wide-128.

The targeted repeat (`evaluation-output-node-repeat-20261019.json`) used the same
three-process/seven-batch configuration, without selecting individual favorable
samples. All times below include input conversion and complete output objects:

| Node workload | Existing JS ms | Previous Rust/WASM ms | Encoder candidate ms | Candidate / previous |
| --- | ---: | ---: | ---: | ---: |
| Plain 1,000 | 0.210718 | 0.203497 | 0.188847 | 0.93x |
| Plain 5,000 | 1.269724 | 1.434552 | 1.667946 | 1.16x |
| Wide 128 | 0.448484 | 0.468247 | 0.398397 | 0.85x |
| Invalid 5,000 control | 0.561014 | 0.319716 | 0.314296 | 0.98x |

Plain-5,000 remained variable: JS process medians ranged from 1.092 to 2.591 ms,
the previous WASM from 1.416 to 1.775 ms, and the candidate from 1.463 to 1.721 ms.
The control was much steadier for WASM (0.310–0.342 ms previous, 0.308–0.319 ms
candidate). This does not establish a universal regression of exactly 16%, but it
does not justify retaining a change intended to improve the large-table case.
The wide-table and small-table wins are insufficient for that objective.

The candidate diagnostic (`profile-output-final-20261019.json`) measured Node
plain-5,000 Rust parsing at 0.471 ms, encoding at 0.068 ms and JS object construction
at 0.516 ms. Its preloaded full-call probe measured 1.103 ms, despite the slower
public-call result in the separate repeat. Different JIT/GC/allocation contexts
matter; the faster probe must not replace the public-call measurement or be
presented as a reduction in the remaining end-to-end gap. Object construction is
still a substantial cost, and this follow-up found no stable improvement to it.

The retained implementation change is the historical-snapshot comparison support
in the benchmark, together with this record of the discarded candidates. There
is no further large-table speedup claim from this round.

The encoder candidate passed all 305 redirected tests, 2,130 cross-language
comparisons, seven additional Unicode writer cases and eight Rust tests. Type
checking and Rust formatting passed. After reverting, both the rebuilt WASM
artifact (954,853 bytes) and JS binding were verified byte-identical to the
previous tested snapshot. The restored browser acceptance check passed again.
The new comparison runner completed both reports and rejects a missing
`--previous` argument.

## Structural follow-up: 2026-10-19

This follow-up extracts the JS binary codec from the WASM binding and keeps
model decoding in one sequential pass. It keeps the sequential checked
reads, field order, eager strings, independent ranges and wire format. The
earlier fixed-offset and object-layout candidates are not included. The codec
can be tested without compiling or instantiating Rust.

Owned calls and borrowed diagnostics now share one response reader and writer
error decoder. Owned results are released in `finally`; diagnostics retain their
buffers until the probe releases response, model and input in order. Rust
diagnostic functions live in `src/profile.rs`, with the original crate exports
and C ABI symbols preserved. No new backend-selection or feature modes are added.

Validation passed: six new transport tests, the existing 305 redirected tests,
2,130 JS/WASM/Python/Go comparisons, seven additional Unicode writer inputs,
eight Rust tests, type checking and Rust formatting. All WASM export names/kinds
match the previous snapshot, and 1,365 writer requests are byte-identical.
Benchmark/profile fingerprints now include every binding `.mjs` module so codec
changes cannot escape artifact verification.

A version with separate row/cell methods was measured first in
`evaluation-structure-20261019.json` (144 fresh processes). Most Node workloads
were within about 1–7% of the previous binding, but plain-5,000 measured 2.173 ms
versus 1.483 ms previously; its process medians ranged from 1.463 to 3.023 ms.
The extra hot-loop call layers were removed while retaining the module boundary,
shared response handling and independent transport tests. The final focused
comparison is recorded separately in `evaluation-structure-flat-20261019.json`.

The final focused run used 54 fresh processes with the normal warmup/batch
configuration. Complete-call medians, without filtering individual samples:

| Runtime / workload | Existing JS ms | Previous binding ms | Refactored binding ms | Refactored / previous |
| --- | ---: | ---: | ---: | ---: |
| Node / plain 1,000 | 0.202005 | 0.193605 | 0.198295 | 1.02x |
| Node / plain 5,000 | 1.103681 | 1.157842 | 1.266502 | 1.09x |
| Node / wide 128 | 0.416603 | 0.487493 | 0.463646 | 0.95x |
| Bun / plain 1,000 | 0.283865 | 0.229401 | 0.241121 | 1.05x |
| Bun / plain 5,000 | 1.270173 | 1.234606 | 1.197316 | 0.97x |
| Bun / wide 128 | 0.618353 | 0.536303 | 0.542505 | 1.01x |

This is a structural improvement with a measured tradeoff, not a speedup claim.
Node plain-5,000 still has substantial variance: previous process medians were
1.115–1.279 ms, refactored 1.182–2.751 ms. The reported median includes the slow
process; the data does not establish a universal 9% penalty or eliminate the gap
to the existing JS implementation. The Rust WASM bytes are identical to the old
snapshot after the diagnostic module move, so this comparison changes only the
JS boundary code.

The final browser check passed with the separate codec module, including bulk
UTF-16 fallback and scanner disposal. All three host adapters also completed a
Node/Bun quick smoke run (`structure-host-smoke-20261019.json`); its short timings
are not a performance conclusion. Parser and writer stage probes passed with
the extracted Rust diagnostics (`profile-structure-20261019.json` and
`writer-structure-20261019.json`).

## Performance after the structural split: 2026-10-19

The retained candidate keeps the codec/runtime boundary and eager public model.
Its Rust changes remove repeated work rather than add separate parser backends:

- Inline the small, frequently called boundary append method.
- Create the code-span hash cache only when mismatched tick runs need it. This
  avoids hash-state initialization on ordinary rows; it is not a claim that the
  old empty `HashMap::new()` allocated a heap buffer on every row.
- Use the previous value returned by a single rowspan-map insertion instead of
  looking up the origin and then inserting it again.
- Append fixed-size metadata as const-sized little-endian records. `Segments`
  always contains a first range, so every cell emits the same nine-word header
  plus first segment, then appends only the remaining segments. Header fields
  are defined once and there is no single-line/multiline encoding fast-path split.

The compact layout is unchanged: 0 means null, 1 identifies the existing table
format. The reader now rejects unknown nonzero format markers before decoding
fields. A measured candidate packing column properties into each cell record
was discarded after wide-table/other-runtime regressions; its format-2 layout
is not retained.

The final diagnostic (`profile-first-record-20261019.json`) measured Node
plain-5,000 encoding at 0.078661 ms versus 0.150005 ms at the start of this round,
and wide-128 encoding at 0.042724 versus 0.088348 ms. Node Rust parsing plus wire
encoding measured 0.529953 versus 0.653824 ms. Bun plain-5,000 encoding measured
0.063996 versus 0.093732 ms, while its combined Rust/wire stage remained close
to the initial value. These are separate diagnostic runs, not additive shares
or a complete-call speedup claim.

The first equal-five-second-warmup Node comparison used three fresh processes
per backend/workload (`evaluation-first-record-steady-20261019.json`):

| Workload | Existing JS ms | Before this round ms | Candidate ms | Candidate / before |
| --- | ---: | ---: | ---: | ---: |
| Plain 5,000 | 1.108382 | 1.345349 | 0.998792 | 0.74x |
| Wide 128 | 0.417520 | 0.456301 | 0.406876 | 0.89x |

Warmup, complete objects, disposal and sampling rules are identical for all
backends within this report. Longer warmup is explicit because the preceding
one-second Node samples showed large JIT/GC variation. All raw process medians
are retained; this run alone does not establish the result for every workload.

The full default run (`evaluation-perf-final-20261019.json`) used the normal
one-second warmup and three fresh processes per backend/workload. Selected
complete-call medians are below; lower is faster:

| Runtime / workload | Existing JS ms | Before this round ms | Candidate ms | Candidate / before |
| --- | ---: | ---: | ---: | ---: |
| Node / plain 1,000 | 0.203016 | 0.202362 | 0.177261 | 0.88x |
| Node / plain 5,000 | 1.172186 | 1.304614 | 1.355381 | 1.04x |
| Node / wide 128 | 0.415971 | 0.459255 | 0.420544 | 0.92x |
| Node / multiline 500 | 0.263407 | 0.152923 | 0.143882 | 0.94x |
| Node / escaped 1,000 | 0.301219 | 0.230127 | 0.308585 | 1.34x |
| Bun / plain 5,000 | 1.157691 | 1.065162 | 1.056783 | 0.99x |
| Bun / wide 128 | 0.569222 | 0.520155 | 0.498639 | 0.96x |
| Bun / escaped 1,000 | 0.357849 | 0.246478 | 0.239641 | 0.97x |

A second equal-five-second-warmup run
(`evaluation-perf-steady-confirm-20261019.json`) reversed the first large-table
result: Node plain-5,000 measured 1.276527 ms versus 1.144498 ms before this
round and 1.082908 ms for existing JS. Bun measured 1.079757 versus 1.065802 ms
before, with existing JS at 1.173121 ms. Longer warmup alone does not stabilize
the Node result, and this round does **not** establish a complete-call speedup
for Node plain-5,000 or close its remaining gap to JS.

The escaped-input follow-up measured Node at 0.210865 versus 0.228183 ms before
and 0.297339 ms for JS; Bun measured 0.240248 versus 0.247649 ms before. The
default Node candidate's three process medians ranged from 0.211090 to
0.558817 ms. The initial apparent 34% regression did not reproduce in the
follow-up, but the variance remains part of the result. Bun's default invalid
5,000 case was 8% slower than before, and multiline-500 was 5% slower; most
other Bun changes were small. These measurements support the encoder/scanner
changes and selected workloads, not a universal throughput improvement.

All 17 workloads completed in Node and Bun, including both writer fixtures and
all three Markdown host adapters. Current host-adapter medians relative to JS
were 0.99–1.23x in Node and 0.92–1.03x in Bun. That report predates historical
host-adapter snapshots, so these are comparisons with JS, not claims
about improvement since the structural split.

Validation passed: 305 redirected tests, seven transport tests, eight Rust
tests, 2,130 complete JS/WASM/Python/Go model/writer comparisons and seven extra
Unicode writer cases. A separate byte comparison against the frozen starting
snapshot matched all 2,130 compact responses and 1,365 writer requests; all 22
WASM export names/kinds also matched (`byte-compat-perf-20261019.json`). Type
checking, Rust formatting, four invalid benchmark-option checks and the real
browser acceptance page passed. The final WASM artifact is 953,708 bytes.

The remaining performance question is complete JS model construction and its
allocation/GC behavior in Node. The retained codec module boundary, eager
result semantics and single Rust backend are unchanged. Public npm exports
still use the existing TypeScript implementation.

## Node allocation and plugin follow-up: 2026-10-19

This round freezes the preceding implementation in
`.performance/object-start-20261019`, including host adapters bound to that
snapshot's own WASM binding. The comparison runner now includes those historical
host adapters, rather than comparing separate runs against a changing TS timing.
The `--snapshot` build option makes that setup reproducible and refuses to
overwrite an existing snapshot.

Two small binding changes are retained:

- Incremental source lookup caches the selected source part within each decoded
  table. Segments on that same part reuse its position; every cross-part lookup
  uses the existing upper-bound search. It preserves the previous last-equal-offset
  choice and validates that each segment fits its selected source part. The
  cursor belongs to one `finish()` call, so snapshots remain independent.
- Boundary responses use a direct signed-integer loop instead of generic
  `Array.from` decoding. This removes the temporary length object and per-item
  callback machinery from the boundary path used by remark. The returned array
  and signed `-1` sentinel remain unchanged; truncated and extra bytes still fail.

A separate candidate gave cell and segment ranges their own inline allocation
sites and cached the column lookup. The paired Node screen showed no improvement
(plain-1,000 1.08x, plain-5,000 1.02x and wide-128 1.01x versus the snapshot), so
it was reverted. The final `Reader.table` method is source-identical to the
starting snapshot. No object pool, lazy model, shared mutable ranges or additional
parser backend is introduced. The Rust source and WASM binary are unchanged in
this round.

The initial forward-cursor Node comparison
(`evaluation-source-cursor-20261019.json`) measured remark plain/rich at
0.97x/0.94x and marked plain/rich at 0.93x/1.00x versus the frozen binding;
markdown-it was effectively unchanged. Complete plain-5,000 was 1.08x despite
having the same decoder and Rust implementation, illustrating why a change in
that workload's timing alone cannot establish an allocation improvement. This
forward/backward cursor variant was subsequently discarded: Bun marked/rich
regressed in both `evaluation-object-final-20261019.json` (1.12x) and
`evaluation-object-confirm-20261019.json` (1.27x). The retained same-part cache
has one cross-part search path instead.

CPU samples are retained in `object-start-node.cpuprofile` and
`object-start-plugin.cpuprofile`. Model construction and GC were substantial in
the standalone table run; markdown-it's own Token construction and rendering
dominated the host run. These samples include warmup and are diagnostic, not
steady-state cost percentages or measurements of peak memory.

Validation passed: nine transport tests, 305 redirected tests, eight Rust tests,
2,130 cross-language model/writer comparisons and seven additional Unicode writer
cases. Node separately matched all 2,130 complete models and boundary arrays,
checked all 1,365 writer models, and compared the exact HTML of all three host
adapters across nine fixtures against both TS and the frozen adapter (27 host
comparisons). The browser acceptance page also checks signed boundaries and
multi-cell continuation lookup that moves backward between source lines.

`source-cache-stages-20261019.json` records a separate diagnostic of the retained
cache: three fresh processes per runtime/backend/case, 500 ms warmup and seven
calibrated 20 ms batches. For scanner cases, all input is accepted before timing;
each timed `finish()` constructs a fresh Rust model, wire response and complete
JS model, and releases the response. Input scanning and final scanner disposal
are excluded. The bounds case times a complete call on a short line containing
a matched code span and pipe delimiters.
The raw report includes the worker source, all samples and binding/binary hashes.

| Runtime / operation | Frozen binding ms | Retained binding ms | Retained / frozen |
| --- | ---: | ---: | ---: |
| Node / short-line bounds | 0.000337 | 0.000164 | 0.49x |
| Node / preloaded 5,000-row finish | 1.588658 | 1.182024 | 0.74x |
| Node / preloaded wide-128 finish | 0.446110 | 0.412528 | 0.92x |
| Bun / short-line bounds | 0.000156 | 0.000136 | 0.87x |
| Bun / preloaded 5,000-row finish | 1.506391 | 1.260570 | 0.84x |
| Bun / preloaded wide-128 finish | 0.602489 | 0.585611 | 0.97x |

These are component improvements, not complete `parseTable` or host-rendering
speedups. The same-part cache applies to incremental scanners, not the direct
whole-source `parseTable` path. Public cell/range/segment allocation counts are
unchanged; this round removes temporary boundary-decoder machinery and repeated
source searches, not the eager objects required by the API.

The retained cache's first complete-host report is
`evaluation-source-cache-20261019.json`. Bun marked plain/rich measured 0.97x/0.96x
versus the snapshot; the earlier forward-cursor rich regression did not recur.
Node marked/rich was 1.03x, and remark/rich was 1.03x in Node and 1.04x in Bun.
Node marked/plain had an anomalously slow snapshot median (8.320674 ms versus
2.885589 ms for the candidate and 2.978163 ms for TS); it is not evidence of a
65% speedup. The Node remark TS median also moved from about 43–54 ms in prior
runs to 77 ms in this one. Complete-host timings remain too variable to establish
a stable overall gain from the retained changes.

`evaluation-source-cache-hosts-20261019.json` covers the other retained-cache host
cases with the same normal configuration. Relative to the frozen binding,
remark/plain was 1.03x in Node and 0.94x in Bun; markdown-it plain/rich was
1.02x/0.96x in Node and 1.04x/0.95x in Bun. Together, the two reports cover all
six host fixtures in both runtimes. They show small mixed changes rather than
a universal plugin-chain speedup.

Snapshot creation, pinned adapter imports, rejection of existing destinations,
invalid arguments and legacy snapshots without host adapters were checked.
Type checking, Rust formatting and whitespace checks also passed. The final
browser acceptance and all 27 exact Node host-output comparisons were repeated
after replacing the forward cursor with the same-part cache.
