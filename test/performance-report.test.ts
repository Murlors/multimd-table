import { expect, test } from "bun:test";
import { compare, median, milliseconds, validate, type Report } from "../tooling/performance/report.js";

function report(): Report {
  return {
    schema: 1, createdAt: "2026-10-19T00:00:00Z", revision: "fixture", dirty: false,
    modules: { core: "old-hash" }, corpus: "fixed-corpus",
    environment: { runtime: "node", version: "24", platform: "test", release: "test", arch: "test", cpu: "test", cores: 1, memory: 1024, hosts: { marked: "18" } },
    config: { profile: "full", trials: 2, batches: 3, warmupMs: 1000, batchMs: 40 },
    measurements: [{ id: "core/plain", bytes: 42, samples: [[1, 2, 90], [2, 3, 100]] }],
  };
}

test("performance summary uses process medians without mutating raw samples", () => {
  const input = report();
  const snapshot = structuredClone(input);
  expect(milliseconds(input.measurements[0]!)).toBe(2.5);
  expect(median([4, 1, 3, 2])).toBe(2.5);
  expect(input).toEqual(snapshot);
});

test("performance comparison allows code changes and reports positive time as slower", () => {
  const before = report(), after = report();
  after.modules.core = "new-hash";
  after.revision = "new-revision";
  after.measurements[0]!.samples = [[2, 4, 180], [4, 6, 200]];
  expect(compare(before, after)).toContain("+100.0%");
  expect(compare(after, before)).toContain("-50.0%");
});

test("performance comparison rejects changed environments, corpus and profiles", () => {
  for (const mutate of [
    (r: Report) => { r.environment.version = "25"; },
    (r: Report) => { r.environment.cpu = "different"; },
    (r: Report) => { r.environment.hosts.marked = "19"; },
    (r: Report) => { r.corpus = "changed"; },
    (r: Report) => { r.config.profile = "quick"; },
    (r: Report) => { r.measurements[0]!.id = "other"; },
  ]) {
    const after = report();
    mutate(after);
    expect(() => compare(report(), after)).toThrow();
  }
});

test("performance reports reject missing, duplicated and invalid timings", () => {
  for (const mutate of [
    (r: Report) => { r.measurements = []; },
    (r: Report) => { r.measurements.push(structuredClone(r.measurements[0]!)); },
    (r: Report) => { r.measurements[0]!.samples.pop(); },
    (r: Report) => { r.measurements[0]!.samples[0]!.pop(); },
    ...[0, -1, NaN, Infinity].map(value => (r: Report) => { r.measurements[0]!.samples[0]![0] = value; }),
  ]) {
    const input = report();
    mutate(input);
    expect(() => validate(input)).toThrow();
  }
});
