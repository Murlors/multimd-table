import { evaluate, type Result } from "./document.ts";
import type { SharedState } from "./state.ts";

export interface Request extends SharedState {
  id: number;
}
export type Response = { id: number; result: Result } | { id: number; error: string };

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
