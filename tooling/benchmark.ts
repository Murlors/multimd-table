import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { cpus, release, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { fixtures } from "./performance/corpus.js";
import { compare, milliseconds, validate, type Report } from "./performance/report.js";
import type { Table } from "../src/core.js";
import type { WriteTable } from "../src/writer.js";

// 构建产物固定在 .performance/；所有入口及子进程均使用同一个仓库根目录。
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = fileURLToPath(import.meta.url);
const profiles = {
  full: { profile: "full", warmupMs: 1000, batchMs: 40, batches: 7, trials: 3 },
  quick: { profile: "quick", warmupMs: 100, batchMs: 15, batches: 3, trials: 1 },
};
const workloads = [
  ...fixtures.map(fixture => ({ id: `core/${fixture.id}`, fixture, operation: "core" })),
  ...["writer", "remark", "marked", "markdown-it"].flatMap(operation =>
    ["plain-1000", "rich-1000"].map(id => ({ id: `${operation}/${id}`, fixture: fixtures.find(fixture => fixture.id === id)!, operation }))),
];
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

function run(executable: string, args: string[], timeout = 60_000): string {
  const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024 });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${executable} failed: ${result.stderr}`);
  return result.stdout;
}

async function load(name: string) {
  return import(pathToFileURL(resolve(root, "dist", `${name}.js`)).href);
}

/** 每个工作负载/轮次独占新进程；准备输入、加载宿主和正确性检查均在计时之外。 */
async function worker(id: string, profile: keyof typeof profiles) {
  const workload = workloads.find(workload => workload.id === id);
  assert.ok(workload, `Unknown workload: ${id}`);
  const config = profiles[profile];
  const { source, options, rows } = workload.fixture;
  const { parseTable } = await load("core") as typeof import("../src/core.js");
  const model = parseTable(source, options);
  assert.deepEqual(model?.sections.map(section => section.rows.length) ?? null, rows);
  let operation: () => Table | string | null;
  if (workload.operation === "core") operation = () => parseTable(source, options);
  else if (workload.operation === "writer") {
    const { stringifyTable } = await load("writer") as typeof import("../src/writer.js");
    assert.ok(model);
    operation = () => stringifyTable(model);
    const output = stringifyTable(model);
    const parsed = parseTable(output, { ...options, multiline: true, headerless: true });
    const structure = (table: WriteTable | null) => table?.sections.map(section => section.rows.map(row => row.cells.map(cell => [cell.column, cell.colspan, cell.rowspan, cell.value])));
    assert.deepEqual(structure(parsed), structure(model));
  } else if (workload.operation === "remark") {
    const [{ unified }, { default: parse }, { default: rehype }, { default: stringify }, { default: adapter }] = await Promise.all([
      import("unified"), import("remark-parse"), import("remark-rehype"), import("rehype-stringify"), load("remark"),
    ]);
    const processor = unified().use(parse).use(adapter, options).use(rehype).use(stringify);
    operation = () => String(processor.processSync(source));
  } else if (workload.operation === "marked") {
    const [{ Marked }, { default: adapter }] = await Promise.all([import("marked"), load("marked")]);
    const parser = new Marked(adapter(options));
    operation = () => parser.parse(source, { async: false });
  } else {
    const [{ default: MarkdownIt }, { default: adapter }] = await Promise.all([import("markdown-it"), load("markdown-it")]);
    const parser = new MarkdownIt().use(adapter, options);
    operation = () => parser.render(source);
  }
  let sink = operation();
  if (!["core", "writer"].includes(workload.operation)) {
    assert.equal(typeof sink, "string");
    const html = sink as string;
    assert.equal((html.match(/<tr[ >]/g) ?? []).length, rows!.reduce((a, b) => a + b, 0));
    if (options.rowspan) assert.ok(html.includes('rowspan="2"') && html.includes('colspan="2"'));
  }
  const gc = (globalThis as { gc?: () => void }).gc;
  assert.ok(gc, "Explicit GC is required; invoke the benchmark runner instead of the worker directly");
  gc();
  const until = performance.now() + config.warmupMs;
  do { sink = operation(); } while (performance.now() < until);
  // 校准批次长度后只在批次首尾读时钟；正常分配与 GC 留在测量内。
  let iterations = 1;
  let elapsed = 0;
  do {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink = operation();
    elapsed = performance.now() - start;
    if (elapsed >= 5 || iterations >= 16384) break;
    iterations *= 2;
  } while (true);
  iterations = Math.max(1, Math.min(16384, Math.ceil(iterations * config.batchMs / elapsed)));
  const samples: number[] = [];
  for (let batch = 0; batch < config.batches; batch++) {
    const start = performance.now();
    for (let i = 0; i < iterations; i++) sink = operation();
    samples.push((performance.now() - start) / iterations);
  }
  // 保留最后一次输出，确保测量确实消费解析/渲染结果。
  assert.equal(sink === null, workload.operation === "core" && rows === null);
  console.log(JSON.stringify({ samples, runtime: process.versions.bun ? "bun" : "node", version: process.versions.bun ?? process.versions.node }));
}

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === "--worker") {
    assert.ok(args[2] === "quick" || args[2] === "full");
    return worker(args[1]!, args[2]);
  }
  if (args[0] === "--compare") {
    assert.equal(args.length, 3, "Usage: bun run bench:compare BEFORE.json AFTER.json");
    const [before, after] = await Promise.all(args.slice(1).map(path => readFile(path, "utf8").then(JSON.parse)));
    console.log(compare(before, after));
    return;
  }
  let runtime = "all";
  let output = ".performance/latest";
  let profile: keyof typeof profiles = "full";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--quick") profile = "quick";
    else if (args[i] === "--runtime") runtime = args[++i]!;
    else if (args[i] === "--out") output = args[++i]!;
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  assert.ok(["all", "node", "bun"].includes(runtime), "--runtime must be all, node or bun");
  assert.ok(output, "--out requires a path prefix");
  const modules: Record<string, string> = {};
  for (const name of ["core", "writer", "remark", "marked", "markdown-it"]) {
    modules[name] = digest(await readFile(resolve(root, "dist", `${name}.js`)));
  }
  for (const name of ["backend.js", "wasm-data.js", "wasm.mjs", "wire.mjs"]) {
    modules[`internal/${name}`] = digest(await readFile(resolve(root, "dist/internal", name)));
  }
  const hosts: Record<string, string> = {};
  for (const name of ["unified", "remark-parse", "remark-rehype", "rehype-stringify", "mdast-util-from-markdown", "marked", "markdown-it"]) {
    hosts[name] = JSON.parse(await readFile(resolve(root, "node_modules", name, "package.json"), "utf8")).version;
  }
  const corpus = digest(JSON.stringify(fixtures) + await readFile(entry, "utf8"));
  for (const engine of runtime === "all" ? ["node", "bun"] : [runtime]) {
    const report: Report = {
      schema: 1, createdAt: new Date().toISOString(),
      revision: run("git", ["rev-parse", "HEAD"]).trim(), dirty: !!run("git", ["status", "--porcelain"]).trim(),
      modules, corpus,
      environment: { runtime: engine, version: "", platform: process.platform, release: release(), arch: process.arch, cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length, memory: totalmem(), hosts },
      config: profiles[profile],
      measurements: workloads.map(workload => ({ id: workload.id, bytes: Buffer.byteLength(workload.fixture.source), samples: [] })),
    };
    // 轮次交错并反转工作负载顺序，降低固定顺序和机器温度对单一样本的偏置。
    for (let trial = 0; trial < report.config.trials; trial++) {
      const order = trial % 2 ? [...workloads].reverse() : workloads;
      for (const workload of order) {
        console.error(`${engine} ${profile} trial ${trial + 1}/${report.config.trials}: ${workload.id}`);
        const result = JSON.parse(run(engine, ["--expose-gc", entry, "--worker", workload.id, profile]));
        assert.equal(result.runtime, engine);
        if (report.environment.version) assert.equal(result.version, report.environment.version);
        report.environment.version = result.version;
        report.measurements.find(row => row.id === workload.id)!.samples.push(result.samples);
      }
    }
    validate(report);
    const path = resolve(root, `${output}-${engine}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(report, null, 2) + "\n", { flag: "wx" });
    console.log(`\n${engine} ${report.environment.version} (${profile}): ${path}`);
    console.log("| Workload | ms/op | ops/s | Process median min–max ms |\n| --- | ---: | ---: | ---: |");
    for (const row of report.measurements) {
      const ms = milliseconds(row);
      const medians = row.samples.map(samples => milliseconds({ ...row, samples: [samples] }));
      console.log(`| ${row.id} | ${ms.toFixed(6)} | ${(1000 / ms).toFixed(0)} | ${Math.min(...medians).toFixed(6)}–${Math.max(...medians).toFixed(6)} |`);
    }
  }
}

await main();
