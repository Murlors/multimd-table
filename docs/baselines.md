# Correctness and performance baselines

## Correctness

Run `vp run verify` for format/lint/type checks, Rust tests, library/transport
tests in production and development conditions, Playground tests, both production
builds and isolated packed-package consumers. CI uses this same complete gate.
`vp run verify:package` runs only the build and isolated package acceptance.

`vp test` runs all three Vitest projects; use `--project production`,
`--project development` or `--project playground` to select one. Tests and packaging
share `tooling/prepare-wasm.ts` to prepare the locked Rust/WASM module automatically.
`vp check` checks the whole workspace, including Playground types. Verification
and measurement commands do not cache results.
The root test config collects the JS package's production/development projects
and the Playground project. `vp -C packages/js test` runs only the JS/transport projects.

The baseline combines existing hand-written syntax contracts and new generated checks:

- All three adapters render the shared syntax cases and all 32 option combinations
  against explicit expected HTML. Host-specific behavior has separate tests.
- `packages/js/test/baseline.test.ts` compares pipe boundaries against an independent, slow
  reference scanner for all 87,381 strings over `a`, `|`, backtick and backslash
  through length 8, plus 3,000 seeded Unicode/whitespace/delimiter-run samples.
- Another 1,000 seeded documents exercise malformed input, mixed line endings,
  scanner rejection and snapshot independence. Cell segments must reconstruct
  the original Markdown value, and all source ranges must remain valid UTF-16
  intervals. Scanner/whole-string equivalence is supplementary, not an independent
  grammar oracle.
- Writer tests include 200 seeded grids with a header and two body sections,
  row/column spans, alignment, captions, empty cells, inline Markdown and blocks.
  Round trips compare structure and rendered Markdown semantics, not raw spelling.
  Unrepresentable content must still fail explicitly.
- Performance fixtures are also checked for expected section row counts and source
  coordinates, so shortening the parsed input cannot silently look like a speedup.
- `packages/js/test/runtime.test.ts` checks lazy scanner allocation, deterministic and scoped
  plugin cleanup, exception paths, mutable options, large document offsets and
  independent snapshots. Test teardown releases scanners explicitly held by older
  cases; lifecycle assertions run before that cleanup.
- `packages/js/test/contracts.ts` verifies 2,130 complete parser/writer cases and seven Unicode
  writer boundaries against frozen results from the former TS implementation.
  `contracts/core-contracts.json` stores SHA-256 summaries in groups of at most
  100 cases, plus incremental scanner contracts. Object keys are sorted before
  hashing; arrays, strings and ranges remain significant. Failures identify the
  affected group. Intentional contract changes require review rather than automatic
  regeneration from current output. The old TS implementation is no longer retained.

Failures in generated cases include the seed, sample and relevant input. Add a
small, explicit regression case when fixing a discovered issue. Production data
should be minimized and stripped of private content before becoming a fixture.

## Performance

From the repository root, with dependencies installed and Node and Bun available:

```sh
# Full measurement, both runtimes. Choose a fresh output prefix for each run.
vp run bench --out .performance/baseline
vp run bench --out .performance/candidate

# Compare each runtime separately. Negative time change means faster.
vp run bench:compare .performance/baseline-node.json .performance/candidate-node.json
vp run bench:compare .performance/baseline-bun.json .performance/candidate-bun.json

# One runtime, or a shorter smoke run for CI/tooling development.
vp run bench --runtime node --out .performance/node-only
vp run bench --quick --out .performance/smoke
```

`bench` builds the production modules before measuring and runs the same TypeScript
script directly on Node and Bun. It
does not install dependencies, fetch an old release or modify library sources.
Every build recreates `packages/js/dist/`, so removed entry points and old source maps cannot
survive in the generated output.
Reports use exclusive creation: existing results are never overwritten.

The fixed corpus lives in `tooling/performance/corpus.ts`. There are 17 workloads:
nine core cases (small/medium/large plain tables, combined spans and body sections,
multiline cells, escaped pipes/code/Unicode, a wide table, unmatched backtick runs,
and a delimiter-free candidate); writer plus each adapter run on the same plain
and rich cases. Adapter timings include the host's complete parse/render pipeline
with a reused processor, not just this package's incremental cost. Core timings
do not load host parsers. The core only reads a leading table; the invalid candidate
exercises scanning without finding a delimiter, not whole-document table discovery.

Each workload/trial uses a fresh process loading the same built modules. Preparation
and validation happen outside timing. Explicit GC runs before warmup, then normal
allocation and GC remain inside measurements. Full runs use three processes per
workload/runtime, 1,000 ms warmup and seven calibrated batches targeting 40 ms each.
Batch size is capped at 16,384 operations; expensive operations can exceed the target.
The summary is the median of per-process batch medians, with operations/second and
the range of process medians. Raw per-batch ms/op remain in JSON. The quick profile
uses one process, 100 ms warmup and three batches targeting 15 ms; it checks the
measurement path, not release performance.

Reports record runtime/host versions, OS/architecture/CPU, revision, dirty state,
module hashes (including the WASM file, loader and binding), corpus/runner fingerprint and measurement settings. Comparisons reject
different environments, profiles, fixtures or workload sets. Code/module hashes may
change, as expected when comparing implementations. A changed corpus or runner needs
a new baseline. Runtime startup and cold-start performance, retained heap and peak
memory are not measured by this suite.

Run on the same quiet machine and runtime versions, alternating baseline/candidate
order across repeated runs when investigating a regression. Hardware labels do not
capture load, power mode or thermal throttling; identical metadata alone cannot
guarantee comparable results. Small differences need replication. No wall-clock
threshold blocks CI yet.

CI runs the quick profile on Node and Bun and uploads both JSON reports as the
`performance-<commit>` artifact. Script errors and failed output checks fail the job;
timing fluctuations do not. Download artifacts from GitHub Actions for inspection,
and use full local runs for performance decisions. Machine-specific reports and the
generated vectors stay under ignored `.performance/`, outside the npm package.

The [Rust shared core](../crates/core/README.md) supplies the default package and
the native Python package and Go probe. `core:check` validates frozen regression contracts
and the Go binding; the Python acceptance command validates the installed native package; `core:profile` isolates transport, Rust execution and
object construction. `bench` and `bench:compare` maintain performance comparisons
between saved reports.

## Packed-package and consumer acceptance

`vp run verify:package` packs the actual whitelist of published files, installs
that tarball into isolated consumers and checks Node, Bun and TypeScript. Core
and writer declarations are checked without DOM types or optional peers. The
core probe warms a 5,000-row workload, then checks 100 further parses without
additional WASM memory growth. First-import observations are recorded separately
from throughput; they include module loading/compilation, not process startup.

The validated tarball and metadata remain in `.performance/package-acceptance/`.
Browser fixtures are generated from an isolated installation, not source aliases.
Serve the repository over local HTTP and open
`/.performance/package-browser/index.html` to check unbundled synchronous APIs,
bundled host adapters, Unicode, large source offsets and a real module Worker.
The fixture CSP permits only same-origin scripts and WASM compilation. Worker
bundles select the `worker` condition for document-free entity decoding.
The page covers the unbundled external WASM file and bundler-inlined WASM under
that CSP. Node SSR acceptance keeps the package external so its binary resolves
inside the installed package. Fully bundled SSR needs bundler-specific asset
handling and is not a supported zero-configuration path.

For Playground browser acceptance, edit a table repeatedly, reset the example,
apply canonical write-back, and reopen a share link. Confirm both the model and
the rendered iframe update after each action; a successful parser status alone
does not establish that the isolated preview document rendered.

A consumer's existing Bun tests can run against that exact tarball:

```sh
bun packages/js/tooling/check-consumer.ts ../consumer tests/table-editor.test.ts
```

The runner verifies the archive hash, unpacks inside this repository's
`.performance/`, and maps package imports to its real exports through a test
preload. It verifies the resolved parser identity and checks for live scanners
after each test. Consumer sources, dependencies and configuration are unchanged;
tests execute in their original environment so relative resources keep working.

Local migration acceptance used Noumi's `workspace-rich-multimd`,
`chat-markdown-multimd` and `chat-markdown-worker` suites: 25 tests covered native
editing, save/reopen, merged cells, references, HTML handling and Worker result
coordination. This was package-based local testing, not an update or deployment
of Noumi's installed dependency. Browser Worker module loading is checked by the
separate packed-package page.

## Playground

[Open the Playground](https://murlors.github.io/multimd-table/). The static site
uses the published `multimd-table@0.4.0` package. Try merged
cells, multiline content, headerless tables and escaping; switch between rendered
Markdown, the complete model and canonical writer output. Parser options update
live. You can copy results, apply written Markdown without losing the rest of the
document, or share an example through a URL fragment.

```sh
vp install
vp dev
```

Open `http://127.0.0.1:4173`. Vite updates the page as sources change. No Rust toolchain is needed. Parsing and rendering run in a
browser Worker; input is not uploaded. Preview runs in a sandbox with scripts and
remote content disabled. Share links contain their Markdown, so only share input
you intend others to read.

Run `vp -C playground check`, `vp -C playground test` and `vp build`
for static checks, boundary tests and a production build. The deployable files are in `playground/dist/`; their relative asset URLs
also work under a project subdirectory. Serve them with any static host.

The public site is hosted on GitHub Pages. The **Playground** workflow builds the
pinned npm release and deploys `playground/dist/` when manually run on `main`.
Pushes and pull requests validate the project without changing the public site.
When updating the demo, change its npm release pin and displayed version together,
then test, build and run the deployment workflow.

## Development

The root is a private workspace. `packages/js/` owns the npm package and its tests;
`packages/python/` owns the Python package and PyO3 bridge. Both use `crates/core/`.
Frozen compatibility hashes live once in `contracts/core-contracts.json`.

Cross-language tooling and the shared performance corpus stay in `tooling/`.
JS package acceptance, downstream-consumer checks and benchmarks live in
`packages/js/tooling/`. Playground remains a separate workspace using the published
npm release. Package names and public import paths are unchanged.

`bunfig.toml` disables implicit workspace linking so the demo's npm alias remains
the registry package. Playground tests check its resolved location and version.

The npm README is generated from the root README during the JS build, with absolute
documentation links. Publish npm from `packages/js/`, never from the private root.
The JS package's `prepack` checks its own sources, tests, build and packed consumers;
CI runs the complete repository gate separately.

The root config sets default targets: `vp pack` packages the JS library, while
`vp dev`, `vp build` and `vp preview` operate on Playground. The root has no build
script forwarding to a child package. Explicit `vp -C <package>` commands still work.
With Vite+ 1.3, pass app-command arguments with an explicit target, for example
`vp -C playground dev --port 4187`; bare-command defaults do not route these calls.

Use Vite+ with the latest Node.js LTS (`vp env default lts`) and the Bun version
declared in `packageManager`. Vite+ and shared markdown-it versions are declared
in the root catalog; CI reads the same toolchain version and uses Node.js LTS.
Run `vp install` once at the repository root. Core development also requires
Rust and the `wasm32-unknown-unknown` target
(`rustup target add wasm32-unknown-unknown`).

| Command                 | Purpose                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------- |
| `vp check`              | Format, lint and type checks across the repository                                      |
| `vp test`               | Library/transport tests in production and development conditions, plus Playground tests |
| `vp pack`               | JS ESM entry points and declarations, checked by publint and Are the Types Wrong        |
| `vp dev`                | Playground with live updates                                                            |
| `vp build`              | Playground production build                                                             |
| `vp preview`            | Serve the Playground production build                                                   |
| `vp run verify`         | Complete gate: static checks, Rust/tests, both builds and isolated package consumers    |
| `vp run verify:package` | Build and validate only the actual tarball in Node, Bun, TypeScript and browser bundles |
| `vp run verify:python`  | Build and validate the Python wheel and source archive in an isolated consumer          |

Tests and packaging share one Rust/WASM preparation function. Filter tests with
`vp test --project production`, `--project development` or `--project playground`.
Run `vp check` before committing. CI runs the complete gate; npm package creation
runs the JS package's scoped checks and consumer acceptance.
Verification and performance measurements always execute without task caching.

Formatting and lint rules use Oxfmt/Oxlint defaults with type-aware checks enabled.
The frozen compatibility fixture is excluded from formatting.

Vite+, Vite, TypeScript and Bun types are declared once in the root dev dependencies.
Host libraries and integration-test dependencies belong to the JS package or Playground.
Only the root declares `packageManager`; all workspaces use the root Bun lockfile.

Declaration generation currently uses the TypeScript 6 compiler API; adopting
TypeScript 7 requires compatible declaration tooling.

Python acceptance additionally requires Rust and a CPython build environment with
maturin and mypy. `vp run verify:python` prepares the shared WASM core before
exporting contract vectors; no earlier JS build is required.
See the [Python development guide](../packages/python/README.md#development).
CI checks CPython 3.11 and 3.14 on Linux, macOS and Windows; a configured matrix is
not evidence that every platform has passed locally.

`vp run bench --out .performance/baseline` measures the core, writer and adapters
on Node and Bun. The same TypeScript runner executes directly in both runtimes.
See [Performance](#performance) for workloads and comparisons, and the sections above for cross-language
checks and the packed-package browser acceptance page.
