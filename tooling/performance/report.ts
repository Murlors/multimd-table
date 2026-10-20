import assert from "node:assert/strict";

export interface Measurement {
  id: string;
  bytes: number;
  samples: number[][];
}

export interface Report {
  schema: 1;
  createdAt: string;
  revision: string;
  dirty: boolean;
  modules: Record<string, string>;
  corpus: string;
  environment: {
    runtime: string;
    version: string;
    platform: string;
    release: string;
    arch: string;
    cpu: string;
    cores: number;
    memory: number;
    hosts: Record<string, string>;
  };
  config: { profile: string; warmupMs: number; batchMs: number; batches: number; trials: number };
  measurements: Measurement[];
}

/** 先取各新进程的批次中位数，再取进程间中位数，避免一次长 GC 主导结果。 */
export function median(values: number[]): number {
  assert.ok(
    values.length && values.every((value) => Number.isFinite(value) && value > 0),
    "Expected positive finite timing samples",
  );
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

export function milliseconds(measurement: Measurement): number {
  return median(measurement.samples.map(median));
}

/** 报告来自本地文件；比较前拒绝不完整或不同口径的数据，不把缺项当成零耗时。 */
export function validate(report: Report): void {
  assert.equal(report.schema, 1, "Unsupported report schema");
  const { trials, batches, warmupMs, batchMs } = report.config;
  assert.ok(Number.isInteger(trials) && trials > 0 && Number.isInteger(batches) && batches > 0);
  assert.ok(Number.isFinite(warmupMs) && warmupMs > 0 && Number.isFinite(batchMs) && batchMs > 0);
  assert.ok(report.corpus && Object.keys(report.modules).length);
  assert.ok(report.environment.runtime && report.environment.version && report.environment.cpu);
  assert.ok(report.measurements.length);
  const ids = new Set<string>();
  for (const measurement of report.measurements) {
    assert.ok(measurement.id && !ids.has(measurement.id), "Duplicate or empty workload ID");
    ids.add(measurement.id);
    assert.ok(Number.isInteger(measurement.bytes) && measurement.bytes > 0);
    assert.equal(measurement.samples.length, trials, "Incomplete trials");
    for (const samples of measurement.samples) {
      assert.equal(samples.length, batches, "Incomplete batches");
      median(samples);
    }
  }
}

export function compare(before: Report, after: Report): string {
  validate(before);
  validate(after);
  assert.deepEqual(
    after.environment,
    before.environment,
    "Runtime, host dependencies or hardware differ; rerun on the same environment",
  );
  assert.deepEqual(after.config, before.config, "Measurement profiles differ");
  assert.equal(
    after.corpus,
    before.corpus,
    "Corpus or benchmark harness changed; establish a new baseline",
  );
  assert.deepEqual(
    after.measurements.map((row) => [row.id, row.bytes]),
    before.measurements.map((row) => [row.id, row.bytes]),
    "Workload sets differ",
  );
  return [
    "| Workload | Before ms/op | After ms/op | Time change |",
    "| --- | ---: | ---: | ---: |",
    ...after.measurements.map((row, i) => {
      const old = milliseconds(before.measurements[i]!);
      const current = milliseconds(row);
      const change = (current / old - 1) * 100;
      return `| ${row.id} | ${old.toFixed(6)} | ${current.toFixed(6)} | ${change >= 0 ? "+" : ""}${change.toFixed(1)}% |`;
    }),
    "",
    "Negative time change means faster. Small differences require repeated runs; this report sets no pass/fail threshold.",
  ].join("\n");
}
