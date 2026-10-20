// 诊断探针与发布入口使用同一绑定实现，避免两份编解码逻辑漂移。
export {
  createCore,
  defaults,
  flags,
  encodeWrite,
  expandSection,
} from "../../../packages/js/src/internal/wasm.mjs";
