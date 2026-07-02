// メインスレッド側 LLM 状態管理ファサード（UI との契約）。React 非依存。
// Worker のライフサイクル・進捗・生成キューを隠蔽し、購読可能な状態を提供する。

import type {
  ChatMessage,
  LlmVariant,
  WorkerRequest,
  WorkerResponse,
} from './messages.ts';

export type { LlmVariant, ChatMessage } from './messages.ts';

export type LlmStatus = 'idle' | 'unsupported' | 'loading' | 'ready' | 'error';

export type LlmState = {
  status: LlmStatus;
  variant: LlmVariant | null;
  progress: number;
  progressText: string;
  error: string | null;
};

// ---- 状態と購読 ----

let state: LlmState = {
  status: 'idle',
  variant: null,
  progress: 0,
  progressText: '',
  error: null,
};

const subscribers = new Set<(s: LlmState) => void>();

function setState(patch: Partial<LlmState>): void {
  state = { ...state, ...patch };
  for (const cb of subscribers) cb(state);
}

export function getLlmState(): LlmState {
  return state;
}

/** 即時に現在状態を1回通知し、以後は変化時に通知。戻り値で購読解除。 */
export function subscribeLlm(cb: (s: LlmState) => void): () => void {
  subscribers.add(cb);
  cb(state);
  return () => {
    subscribers.delete(cb);
  };
}

// ---- 環境判定 ----

export async function isWebGpuAvailable(): Promise<boolean> {
  try {
    const gpu = (navigator as Navigator & { gpu?: { requestAdapter: () => Promise<unknown> } }).gpu;
    if (!gpu) return false;
    const adapter = await gpu.requestAdapter();
    return adapter != null;
  } catch {
    return false;
  }
}

/** deviceMemory < 8GB なら E2B を推奨（未定義なら E4B）。 */
export function recommendedVariant(): LlmVariant {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  if (typeof mem === 'number' && mem < 8) return 'E2B';
  return 'E4B';
}

// ---- Worker 管理 ----

let worker: Worker | null = null;
// 生成中リクエストの resolver 群（id → {resolve, reject}）。
const pending = new Map<string, { resolve: (t: string) => void; reject: (e: Error) => void }>();
// ロード完了/失敗を待つ Promise の resolver。
let loadResolvers: { resolve: () => void; reject: (e: Error) => void } | null = null;

function ensureWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (ev: MessageEvent<WorkerResponse>) => handleWorkerMessage(ev.data);
  worker.onerror = (ev: ErrorEvent) => {
    const message = ev.message || 'Worker エラー';
    // ロード中なら失敗扱い、生成中の全リクエストも失敗させる。
    if (state.status === 'loading') setState({ status: 'error', error: message });
    loadResolvers?.reject(new Error(message));
    loadResolvers = null;
    for (const [, p] of pending) p.reject(new Error(message));
    pending.clear();
  };
  return worker;
}

function handleWorkerMessage(msg: WorkerResponse): void {
  switch (msg.type) {
    case 'progress':
      setState({ progress: msg.progress, progressText: msg.text });
      break;
    case 'ready':
      setState({ status: 'ready', progress: 1, error: null });
      loadResolvers?.resolve();
      loadResolvers = null;
      break;
    case 'error':
      setState({ status: 'error', error: msg.message });
      loadResolvers?.reject(new Error(msg.message));
      loadResolvers = null;
      break;
    case 'result': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.resolve(msg.text);
      }
      break;
    }
    case 'generateError': {
      const p = pending.get(msg.id);
      if (p) {
        pending.delete(msg.id);
        p.reject(new Error(msg.message));
      }
      break;
    }
  }
}

function postToWorker(req: WorkerRequest, transfer?: Transferable[]): void {
  const w = ensureWorker();
  if (transfer && transfer.length > 0) w.postMessage(req, transfer);
  else w.postMessage(req);
}

// ---- ロード ----

/**
 * 指定 variant のモデルをロードする。非 WebGPU 環境では status='unsupported' にして即 return。
 * すでに ready/loading の場合はそのまま。
 */
export async function loadLlm(variant: LlmVariant): Promise<void> {
  if (state.status === 'loading' || state.status === 'ready') return;

  const supported = await isWebGpuAvailable();
  if (!supported) {
    setState({ status: 'unsupported', error: null, variant: null });
    return;
  }

  setState({ status: 'loading', variant, progress: 0, progressText: 'モデル準備中', error: null });

  return new Promise<void>((resolve, reject) => {
    loadResolvers = { resolve, reject };
    postToWorker({ type: 'load', variant });
  });
}

// ---- 生成（キュー直列化） ----

let generateChain: Promise<unknown> = Promise.resolve();
let idCounter = 0;

/**
 * テキスト生成。status!=='ready' なら throw。
 * 並行呼び出しは Promise チェーンで直列化する（Worker 側の状態競合を避ける）。
 */
export function generateText(opts: {
  messages: ChatMessage[];
  image?: Blob | HTMLCanvasElement;
  maxNewTokens?: number;
}): Promise<string> {
  if (state.status !== 'ready') {
    throw new Error(`LLM が ready ではありません (status=${state.status})`);
  }

  const run = async (): Promise<string> => {
    const id = `gen-${++idCounter}`;
    const imageBitmap = opts.image ? await toImageBitmap(opts.image) : undefined;

    return new Promise<string>((resolve, reject) => {
      pending.set(id, { resolve, reject });
      postToWorker(
        {
          type: 'generate',
          id,
          messages: opts.messages,
          imageBitmap,
          maxNewTokens: opts.maxNewTokens ?? 256,
        },
        imageBitmap ? [imageBitmap] : undefined,
      );
    });
  };

  // 直前のチェーン完了後に実行。失敗は次リクエストへ伝播させない。
  const result = generateChain.then(run, run);
  generateChain = result.catch(() => undefined);
  return result;
}

/** Blob / Canvas を ImageBitmap（transferable）に変換。 */
async function toImageBitmap(image: Blob | HTMLCanvasElement): Promise<ImageBitmap> {
  return createImageBitmap(image);
}

/** テスト・再ロード用: Worker と状態を破棄する。 */
export function disposeLlm(): void {
  if (worker) {
    worker.terminate();
    worker = null;
  }
  for (const [, p] of pending) p.reject(new Error('disposed'));
  pending.clear();
  loadResolvers = null;
  generateChain = Promise.resolve();
  setState({ status: 'idle', variant: null, progress: 0, progressText: '', error: null });
}
