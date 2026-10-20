import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { cpus } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtures } from "./performance/corpus.ts";
import { median } from "./performance/report.ts";

const args = process.argv.slice(2);
const writer = args.includes("--writer");
const root = process.cwd();
const nativePath = "crates/core/target/release/examples/profile";
const bindings = "crates/core/bindings";
const paths = [
  "crates/core/target/wasm32-unknown-unknown/release/multimd_table_core.wasm",
  "packages/js/dist/core.js",
  "crates/core/Cargo.lock",
  "tooling/shared-core-profile.ts",
  "tooling/performance/corpus.ts",
  "tooling/performance/report.ts",
  "packages/js/src/internal/wasm.mjs",
  "packages/js/src/internal/wire.mjs",
  ...["backend.js", "loader.js", "core.wasm", "wasm.mjs", "wire.mjs"].map(
    (name) => `packages/js/dist/internal/${name}`,
  ),
];
if (writer) paths.push("packages/js/dist/writer.js");
assert.ok(
  !writer || !args.includes("--native-only"),
  "Native writer profiling is not implemented; omit --native-only",
);
if (args.includes("--native-only")) paths.push(nativePath);
const fingerprints = () =>
  Object.fromEntries(
    [
      ...paths,
      ...readdirSync(bindings)
        .filter((name) => name.endsWith(".mjs"))
        .sort()
        .map((name) => `${bindings}/${name}`),
    ].map((path) => [path, createHash("sha256").update(readFileSync(path)).digest("hex")]),
  );
if (args[0] === "--worker") {
  const { core } = await import(pathToFileURL(resolve(root, "crates/core/bindings/node.mjs")).href);
  const { parseTable } = await import(
    pathToFileURL(resolve(root, "packages/js/dist/core.js")).href
  );
  const fixture = fixtures.find((f) => f.id === args[1])!;
  const table = writer ? parseTable(fixture.source, fixture.options) : null;
  const { stringifyTable } = writer
    ? await import(pathToFileURL(resolve(root, "packages/js/dist/writer.js")).href)
    : { stringifyTable: null };
  const publicCall = writer
    ? () => stringifyTable(table)
    : () => parseTable(fixture.source, fixture.options);
  const probe = writer ? core.profileWrite(table) : core.profile(fixture.source, fixture.options);
  assert.deepEqual(probe.stages.full(), publicCall());
  const operations: Record<string, () => unknown> = { publicCall, ...probe.stages };
  const samples: Record<string, number[]> = {};
  let sink: unknown;
  // 交替顺序降低固定先后造成的温度/JIT 偏差；组件测量不可直接当作可加总的百分比。
  for (let pass = 0; pass < 3; pass++) {
    const entries = Object.entries(operations);
    for (const [name, operation] of pass % 2 ? entries.reverse() : entries) {
      const until = performance.now() + 150;
      do {
        sink = operation();
      } while (performance.now() < until);
      let count = 1,
        elapsed = 0;
      for (;;) {
        const start = performance.now();
        for (let i = 0; i < count; i++) sink = operation();
        elapsed = performance.now() - start;
        if (elapsed >= 4 || count >= 65536) break;
        count *= 2;
      }
      count = Math.max(1, Math.min(65536, Math.ceil((count * 20) / elapsed)));
      for (let batch = 0; batch < 3; batch++) {
        const start = performance.now();
        for (let i = 0; i < count; i++) sink = operation();
        (samples[name] ??= []).push((performance.now() - start) / count);
      }
    }
  }
  assert.notEqual(sink, undefined);
  probe.dispose();
  console.log(
    JSON.stringify({ id: fixture.id, units: fixture.source.length, bytes: probe.bytes, samples }),
  );
} else {
  const artifacts = fingerprints();
  const measurements: any[] = [];
  const selected = args.includes("--only")
    ? args[args.indexOf("--only") + 1]!.split(",")
    : writer
      ? ["plain-1000", "rich-1000"]
      : ["plain-10", "plain-1000", "plain-5000", "rich-1000", "multiline-500", "wide-128"];
  for (const runtime of args.includes("--native-only") ? ["native"] : ["node", "bun"])
    for (const id of selected) {
      console.error(`${runtime} ${id}`);
      const fixture = fixtures.find((f) => f.id === id);
      assert.ok(fixture, `Unknown fixture ${id}`);
      let child;
      if (runtime === "native") {
        const input = resolve(root, `.performance/shared-core/profile-${id}.utf16`);
        mkdirSync(resolve(root, ".performance/shared-core"), { recursive: true });
        writeFileSync(input, Buffer.from(fixture.source, "utf16le"));
        const bits = [false, false, false, true, true].reduce(
          (n, fallback, i) =>
            n |
            ((fixture.options[
              ["multiline", "rowspan", "headerless", "multibody", "autolabel"][
                i
              ] as keyof typeof fixture.options
            ] ?? fallback)
              ? 1 << i
              : 0),
          0,
        );
        child = spawnSync(nativePath, [input, String(bits)], {
          cwd: root,
          encoding: "utf8",
          timeout: 60_000,
        });
        assert.equal(child.status, 0, child.stderr);
        const stages = child.stdout
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        measurements.push({
          runtime,
          id,
          units: fixture.source.length,
          samples: Object.fromEntries(stages.map((s) => [s.stage, s.samples])),
          allocations: Object.fromEntries(
            stages.map((s) => [s.stage, { count: s.allocations, bytes: s.allocatedBytes }]),
          ),
        });
        continue;
      }
      child = spawnSync(
        runtime,
        [fileURLToPath(import.meta.url), "--worker", id, ...(writer ? ["--writer"] : [])],
        { cwd: root, encoding: "utf8", timeout: 60_000 },
      );
      assert.equal(child.status, 0, child.stderr);
      measurements.push({ runtime, ...JSON.parse(child.stdout) });
    }
  assert.deepEqual(fingerprints(), artifacts, "Measured artifacts changed");
  const prefix = args.includes("--out")
    ? args[args.indexOf("--out") + 1]!
    : `.performance/shared-core/profile-${Date.now()}`;
  mkdirSync(resolve(root, ".performance/shared-core"), { recursive: true });
  writeFileSync(
    `${prefix}.json`,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        cpu: cpus()[0]?.model,
        platform: process.platform,
        arch: process.arch,
        config: args.includes("--native-only")
          ? { warmupMs: 200, batches: 7, calibrationMs: 5, maxCount: 65536 }
          : { rounds: 3, warmupMsPerRound: 150, batchesPerRound: 3, targetBatchMs: 20 },
        versions: {
          node: spawnSync("node", ["--version"], { encoding: "utf8" }).stdout.trim(),
          bun: spawnSync("bun", ["--version"], { encoding: "utf8" }).stdout.trim(),
          rust: spawnSync("rustc", ["--version"], { encoding: "utf8" }).stdout.trim(),
        },
        artifacts,
        measurements,
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const stages = writer
    ? ["publicCall", "input", "copy", "decodeInput", "rust", "rustWire", "decode", "full"]
    : ["publicCall", "input", "scan", "model", "encode", "rust", "rustWire", "decode", "full"];
  let md = `All times are warmed ms/op; standalone stages include their own allocation/free. Do not interpret the sum as an exact percentage decomposition.\n\n| Runtime | Fixture | ${stages.join(" | ")} |\n| --- | --- | ${stages.map(() => "---:").join(" | ")} |\n`;
  for (const row of measurements)
    md += `| ${row.runtime} | ${row.id} | ${stages.map((name) => (row.samples[name] ? median(row.samples[name]).toFixed(6) : "—")).join(" | ")} |\n`;
  writeFileSync(`${prefix}.md`, md, { flag: "wx" });
  console.log(md);
}
