// Worker ⇔ メインスレッド間のメッセージプロトコル型定義。
// worker.ts / runtime.ts の双方が import する共有契約（React 非依存）。

export type LlmVariant = 'E4B' | 'E2B';

/** チャット1発言。content は文字列、またはマルチモーダル部品の配列。 */
export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string | ChatContentPart[];
};

/** マルチモーダル content の1要素。image は Worker 側で受け取った画像に紐づく。 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image' };

// ---- メイン → Worker ----

export type LoadRequest = { type: 'load'; variant: LlmVariant };

export type GenerateRequest = {
  type: 'generate';
  id: string;
  messages: ChatMessage[];
  /** transferable として渡す完成画像（任意）。content 内の image 部品に対応。 */
  imageBitmap?: ImageBitmap;
  maxNewTokens: number;
};

export type WorkerRequest = LoadRequest | GenerateRequest;

// ---- Worker → メイン ----

export type ProgressMessage = { type: 'progress'; progress: number; text: string };
export type ReadyMessage = { type: 'ready' };
export type LoadErrorMessage = { type: 'error'; message: string };
export type ResultMessage = { type: 'result'; id: string; text: string };
export type GenerateErrorMessage = { type: 'generateError'; id: string; message: string };

export type WorkerResponse =
  | ProgressMessage
  | ReadyMessage
  | LoadErrorMessage
  | ResultMessage
  | GenerateErrorMessage;

/** variant → HuggingFace モデルID（Web検索で確認済み）。 */
export const MODEL_IDS: Record<LlmVariant, string> = {
  E4B: 'onnx-community/gemma-4-E4B-it-ONNX',
  E2B: 'onnx-community/gemma-4-E2B-it-ONNX',
};
