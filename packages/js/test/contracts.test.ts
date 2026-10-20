import { test } from "vite-plus/test";
import { contractVectors } from "./contracts.js";

test("Rust preserves frozen parser/writer contracts from the former TS implementation", () => {
  contractVectors();
});
