// LLM 用モジュール Web Worker。モデルのロードと生成はすべてここで行い、
// メインスレッドをブロックしない（SPEC §8: 生成は非同期でブロックしない）。
// このファイルは Worker コンテキスト前提（self がグローバル）。React 非依存。

import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  RawImage,
  type Tensor,
} from '@huggingface/transformers';
import {
  MODEL_IDS,
  type ChatMessage,
  type WorkerRequest,
  type WorkerResponse,
} from './messages.ts';

// Worker グローバル。DOM.WebWorker lib を tsconfig に含めていないため self を最小型で扱う。
const ctx = self as unknown as {
  postMessage: (msg: WorkerResponse) => void;
  onmessage: ((ev: MessageEvent<WorkerRequest>) => void) | null;
};

function post(msg: WorkerResponse): void {
  ctx.postMessage(msg);
}

// ロード済みの processor / model。ready 後のみ非 null。
// 型定義が緩い（_call/generate が any）ため実用上の最小型で保持する。
type LoadedProcessor = {
  apply_chat_template: (messages: unknown, options?: unknown) => unknown;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (input: unknown, ...rest: unknown[]): Promise<any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  batch_decode: (sequences: unknown, options?: unknown) => any;
};
type LoadedModel = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  generate: (opts: Record<string, unknown>) => Promise<any>;
};

let processor: LoadedProcessor | null = null;
let model: LoadedModel | null = null;

// ---- ロード ----

async function handleLoad(variant: 'E4B' | 'E2B'): Promise<void> {
  try {
    const modelId = MODEL_IDS[variant];

    // 複数ファイルの bytes を合算して 0..1 に集約する進捗コールバック。
    const fileTotals = new Map<string, number>();
    const fileLoaded = new Map<string, number>();
    const emitProgress = (text: string): void => {
      let total = 0;
      let loaded = 0;
      for (const v of fileTotals.values()) total += v;
      for (const v of fileLoaded.values()) loaded += v;
      const progress = total > 0 ? Math.min(1, loaded / total) : 0;
      post({ type: 'progress', progress, text });
    };

    // progress_callback は ProgressInfo を受け取る（status ごとに loaded/total 有無が異なる）。
    const progress_callback = (info: {
      status: string;
      file?: string;
      loaded?: number;
      total?: number;
    }): void => {
      if (info.file != null) {
        if (typeof info.total === 'number') fileTotals.set(info.file, info.total);
        if (typeof info.loaded === 'number') fileLoaded.set(info.file, info.loaded);
      }
      emitProgress(info.status === 'progress' ? `ダウンロード中: ${info.file ?? ''}` : info.status);
    };

    post({ type: 'progress', progress: 0, text: 'モデル準備中' });

    // AutoProcessor + Gemma4ForConditionalGeneration（q4f16 / webgpu）。
    processor = (await AutoProcessor.from_pretrained(modelId, {
      progress_callback,
    })) as unknown as LoadedProcessor;

    model = (await Gemma4ForConditionalGeneration.from_pretrained(modelId, {
      dtype: 'q4f16',
      device: 'webgpu',
      progress_callback,
    })) as unknown as LoadedModel;

    post({ type: 'progress', progress: 1, text: '読み込み完了' });
    post({ type: 'ready' });
  } catch (err) {
    processor = null;
    model = null;
    post({ type: 'error', message: toMessage(err) });
  }
}

// ---- 生成 ----

async function handleGenerate(
  id: string,
  messages: ChatMessage[],
  imageBitmap: ImageBitmap | undefined,
  maxNewTokens: number,
): Promise<void> {
  try {
    if (!processor || !model) {
      post({ type: 'generateError', id, message: 'モデル未ロード' });
      return;
    }

    // 画像は ImageBitmap → OffscreenCanvas → RawImage に変換して processor へ渡す。
    let images: RawImage[] | undefined;
    if (imageBitmap) {
      images = [bitmapToRawImage(imageBitmap)];
      imageBitmap.close();
    }

    // apply_chat_template で入力テキストを生成（JSON 出力用途なので thinking は無効）。
    const prompt = processor.apply_chat_template(messages, {
      add_generation_prompt: true,
      tokenize: false,
      enable_thinking: false,
    });

    // processor 本体呼び出しでモデル入力（input_ids / pixel_values 等）を作る。
    const inputs = images
      ? await processor(prompt, images)
      : await processor(prompt);

    const output = await model.generate({
      ...inputs,
      max_new_tokens: maxNewTokens,
      do_sample: false,
    });

    // 生成部分（入力トークン以降）だけを取り出してデコードする。
    const text = decodeGenerated(processor, inputs, output);
    post({ type: 'result', id, text });
  } catch (err) {
    post({ type: 'generateError', id, message: toMessage(err) });
  }
}

/** ImageBitmap を OffscreenCanvas 経由で RawImage 化する。 */
function bitmapToRawImage(bitmap: ImageBitmap): RawImage {
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const g = canvas.getContext('2d');
  if (!g) throw new Error('OffscreenCanvas 2D コンテキスト取得失敗');
  g.drawImage(bitmap, 0, 0);
  return RawImage.fromCanvas(canvas);
}

/** input_ids 長を差し引いて生成トークンのみをデコードする。 */
function decodeGenerated(
  proc: LoadedProcessor,
  inputs: { input_ids?: Tensor } & Record<string, unknown>,
  output: Tensor | { sequences?: Tensor },
): string {
  // generate は Tensor か { sequences } を返しうる。sequences を優先。
  const seq = (output as { sequences?: Tensor }).sequences ?? (output as Tensor);
  const inputLen = inputs.input_ids?.dims?.at(-1) ?? 0;

  // 生成トークン列だけを slice。Tensor#slice は [dim0, [start, end]] 形式。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anySeq = seq as any;
  let toDecode: unknown = seq;
  try {
    if (inputLen > 0 && typeof anySeq.slice === 'function') {
      toDecode = anySeq.slice(null, [inputLen, null]);
    }
  } catch {
    toDecode = seq; // slice 失敗時は全体をデコード（後段でフェンス除去する）
  }

  const decoded = proc.batch_decode(toDecode, { skip_special_tokens: true }) as string[];
  return Array.isArray(decoded) ? (decoded[0] ?? '') : String(decoded ?? '');
}

function toMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

ctx.onmessage = (ev: MessageEvent<WorkerRequest>): void => {
  const msg = ev.data;
  if (msg.type === 'load') {
    void handleLoad(msg.variant);
  } else if (msg.type === 'generate') {
    void handleGenerate(msg.id, msg.messages, msg.imageBitmap, msg.maxNewTokens);
  }
};
