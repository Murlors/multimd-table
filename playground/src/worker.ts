import { evaluate, type Result } from "./document.ts";
import type { SharedState } from "./state.ts";

export interface Request extends SharedState {
  id: number;
}
export type Response =
  | { ready: true }
  | { id: number; result: Result }
  | { id: number; error: string };

const worker = self as unknown as {
  postMessage(message: Response): void;
  onmessage: ((event: MessageEvent<Request>) => void) | null;
};
worker.onmessage = ({ data }) => {
  try {
    worker.postMessage({ id: data.id, result: evaluate(data.source, data.options) });
  } catch (error) {
    worker.postMessage({
      id: data.id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
// WASM 在模块导入时异步加载；通知页面后再接收首个解析请求。
worker.postMessage({ ready: true });
