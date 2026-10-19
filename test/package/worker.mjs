import { check } from "./browser.mjs";

try { self.postMessage({ ok: true, ...check() }); }
catch (error) { self.postMessage({ ok: false, error: String(error.stack || error) }); }
