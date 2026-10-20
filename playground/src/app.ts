import { examples, initialOptions, optionKeys, type Settings } from "./examples.ts";
import { applyWritten, decodeState, encodeState } from "./state.ts";
import { previewDocument } from "./preview.ts";
import type { Result } from "./document.ts";
import type { Request, Response } from "./worker.ts";

function element<T extends HTMLElement>(id: string): T {
  const value = document.getElementById(id);
  if (!value) throw new Error(`Missing Playground element: ${id}`);
  return value as T;
}
const source = element<HTMLTextAreaElement>("source");
const selector = element<HTMLSelectElement>("example");
const preview = element<HTMLIFrameElement>("preview");
const model = element<HTMLPreElement>("model");
const written = element<HTMLPreElement>("written");
const status = element("parse-status");
const summary = element("summary");
const notice = element("notice");
const copyOutput = element<HTMLButtonElement>("copy-output");
const apply = element<HTMLButtonElement>("apply-written");
const tabs = [...document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
let view = "preview";
let result: Result | null = null;
let revision = 0;
let timer: ReturnType<typeof setTimeout>;
let worker: Worker | null = null;
let workerReady = false;
let currentSource = "";
let pending = true;

const options = (): Settings =>
  Object.fromEntries(
    optionKeys.map((key) => [key, element<HTMLInputElement>(key).checked]),
  ) as Settings;
function setOptions(settings: Settings) {
  for (const key of optionKeys) element<HTMLInputElement>(key).checked = settings[key];
}

function setStatus(text: string, kind = "ready") {
  status.textContent = text;
  status.dataset.kind = kind;
}
function updateActions() {
  copyOutput.hidden = view === "preview";
  apply.hidden = view !== "write";
  element("preview-note").hidden = view !== "preview";
  copyOutput.disabled = pending || !result?.table || (view === "write" && result.written === null);
  apply.disabled = pending || result?.written == null;
}
function show(next: Result) {
  pending = false;
  result = next;
  preview.srcdoc = previewDocument(next.html);
  model.textContent = next.table ? JSON.stringify(next.table, null, 2) : "";
  written.textContent = next.written ?? "";
  element("model-empty").hidden = !!next.table;
  element("write-empty").hidden = next.written !== null;
  element("write-empty").textContent =
    next.writeError ?? "Start with a table to see its canonical Markdown.";
  if (next.table) {
    const rows = next.table.sections.reduce((count, section) => count + section.rows.length, 0);
    summary.textContent = `${next.table.columns.length} columns · ${rows} rows · ${next.table.sections.length} sections`;
    setStatus(
      next.writeError ? "Parsed · cannot write back" : "Table parsed",
      next.writeError ? "warning" : "ready",
    );
  } else {
    summary.textContent = "No leading table";
    setStatus(source.value.trim() ? "No leading table" : "Ready when you are", "idle");
  }
  updateActions();
}
function fail(message: string) {
  show({ html: "", table: null, written: null, writeError: message });
  summary.textContent = "Unable to update";
  setStatus("Check your input", "error");
  notice.textContent = message;
}
function run() {
  clearTimeout(timer);
  if (!worker || !workerReady) return;
  currentSource = source.value;
  worker.postMessage({ id: revision, source: currentSource, options: options() } satisfies Request);
}
function schedule() {
  revision++;
  element("characters").textContent = `${source.value.length.toLocaleString()} characters`;
  if (!worker) return;
  notice.textContent = "";
  pending = true;
  updateActions();
  setStatus(workerReady ? "Updating…" : "Loading parser…", "idle");
  clearTimeout(timer);
  timer = setTimeout(run, 120);
}
function loadExample() {
  const example = examples[Number(selector.value)] ?? examples[0]!;
  source.value = example.source;
  setOptions(example.options);
  history.replaceState(null, "", location.pathname + location.search);
  schedule();
}
function loadShared() {
  if (!location.hash) return false;
  try {
    const saved = decodeState(location.hash.slice(1));
    source.value = saved.source;
    setOptions(saved.options);
    return true;
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "This share link is invalid.";
    return false;
  }
}
async function copy(text: string, confirmation: string) {
  try {
    await navigator.clipboard.writeText(text);
    notice.textContent = confirmation;
  } catch {
    notice.textContent = "Clipboard access is unavailable. Select and copy the text manually.";
  }
}

for (const [index, example] of examples.entries())
  selector.add(new Option(example.name, String(index)));
source.value = examples[0]!.source;
setOptions(initialOptions);
loadShared();
const initialNotice = notice.textContent;
preview.srcdoc = previewDocument("");

try {
  worker = new Worker(new URL("./worker.ts", import.meta.url), { type: "module" });
  worker.onmessage = ({ data }: MessageEvent<Response>) => {
    if ("ready" in data) {
      workerReady = true;
      run();
      return;
    }
    // 只接收最新输入的结果，旧 Worker 响应不能覆盖用户正在编辑的内容。
    if (data.id !== revision) return;
    if ("result" in data) show(data.result);
    else fail(data.error);
  };
  worker.onerror = () => {
    worker?.terminate();
    worker = null;
    fail(
      "The parser could not load. Reload the page and check that WebAssembly is allowed by your browser.",
    );
    setStatus("Parser unavailable", "error");
  };
  schedule();
  notice.textContent = initialNotice;
} catch {
  worker?.terminate();
  worker = null;
  fail("This Playground needs Web Workers and WebAssembly. Try a current browser.");
  setStatus("Parser unavailable", "error");
}

source.addEventListener("input", schedule);
source.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    run();
  }
});
selector.addEventListener("change", loadExample);
element("reset").addEventListener("click", loadExample);
for (const key of optionKeys) element(key).addEventListener("change", schedule);
element("copy-source").addEventListener("click", () => copy(source.value, "Markdown copied."));
copyOutput.addEventListener("click", () => {
  if (!result?.table) return;
  void copy(
    view === "model" ? JSON.stringify(result.table, null, 2) : (result.written ?? ""),
    "Output copied.",
  );
});
apply.addEventListener("click", () => {
  if (!result?.table || result.written === null) return;
  source.value = applyWritten(currentSource, result);
  schedule();
  source.focus();
});
element("share").addEventListener("click", async () => {
  try {
    const url = new URL(location.href);
    url.hash = encodeState({ source: source.value, options: options() });
    history.replaceState(null, "", url);
    await copy(url.href, "Share link copied. Anyone with the link can see this example.");
  } catch (error) {
    notice.textContent = error instanceof Error ? error.message : "Could not create a share link.";
  }
});
function selectTab(tab: HTMLButtonElement) {
  view = tab.dataset.view!;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute("aria-selected", String(selected));
    item.tabIndex = selected ? 0 : -1;
    element(item.getAttribute("aria-controls")!).hidden = !selected;
  }
  updateActions();
}
for (const tab of tabs) tab.addEventListener("click", () => selectTab(tab));
element("output-tabs").addEventListener("keydown", (event) => {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
  event.preventDefault();
  const index = tabs.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    event.key === "Home"
      ? 0
      : event.key === "End"
        ? tabs.length - 1
        : (index + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length;
  selectTab(tabs[next]!);
  tabs[next]!.focus();
});
window.addEventListener("hashchange", () => {
  if (loadShared()) schedule();
});
