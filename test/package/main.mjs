const result = document.getElementById("result");
try {
  const start = performance.now();
  const core = await import("./package/dist/core.js");
  const { stringifyTable } = await import("./package/dist/writer.js");
  const initializationMs = performance.now() - start;
  const table = core.parseTable("A|B\n-|-\nx||\n^^||", { rowspan: true });
  if (core.parseTable(stringifyTable(table), { rowspan: true }).sections[1].rows[0].cells[0].rowspan !== 2) throw new Error("Unbundled package mismatch");
  const { check } = await import("./browser.js");
  const bundled = check();
  const worker = new Worker("./worker.js", { type: "module" });
  const workerResult = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { worker.terminate(); reject(new Error("Worker timed out")); }, 15000);
    worker.onmessage = ({ data }) => { clearTimeout(timeout); worker.terminate(); data.ok ? resolve(data) : reject(new Error(data.error)); };
    worker.onerror = event => { clearTimeout(timeout); worker.terminate(); reject(new Error(event.message)); };
  });
  result.textContent = `PASS: installed package, unbundled synchronous APIs, bundled plugins, browser Worker, UTF-16, safe offsets and disposal\n${JSON.stringify({ initializationMs, bundled, workerResult })}`;
  document.documentElement.dataset.status = "passed";
} catch (error) {
  result.textContent = `FAIL: ${error.stack || error}`;
  document.documentElement.dataset.status = "failed";
}
