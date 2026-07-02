// UI が呼ぶ高水準 API。LLM 経路 + テンプレ/null フォールバック内蔵。
// SPEC §1: LLM 未ロードでも全フロー完走できること。絶対に throw で UI を壊さない。React 非依存。

import type { Prompt, Category, Evaluation, UserStats, SessionMode } from '../store/types.ts';
import type { SceneSpec } from '../scene3d/generator.ts';
import { getLlmState, generateText } from './runtime.ts';
import { extractJson, promptGenSchema, feedbackSchema } from './schemas.ts';
import {
  buildPromptGenMessages,
  buildMitateMessages,
  buildFeedbackMessages,
  weakestCategories,
} from './prompts.ts';

// ---- テンプレ用モチーフ表（各カテゴリ5個以上）----

const MOTIFS: Record<Category, string[]> = {
  hand: ['開いた手', '握った手', '何かを持つ手', '指差す手', '組んだ両手', '横から見た手'],
  perspective: ['一点透視の廊下', '二点透視の建物', '見上げたビル', '道路と電柱', '階段', '箱の積み重ね'],
  animal: ['座る猫', '走る犬', '飛ぶ鳥', '魚', 'うさぎ', '馬の横顔'],
  pose: ['立ちポーズ', '座るポーズ', '歩く人', '振り向く人物', '腕を上げた人', 'しゃがむ人'],
  still: ['りんごとコップ', '瓶と布', '積んだ本', 'ティーポット', '果物の盛り合わせ', '靴'],
  gesture: ['30秒ジェスチャー', '動きのあるポーズ', 'ダンスの一瞬', 'スポーツの動作', '跳ぶ人', '投げる動作'],
  other: ['好きなモチーフ', '身の回りの小物', '窓の外の風景', '植物', '雲', 'マグカップ'],
};

const CONSTRAINT_POOL = ['30秒で', '輪郭線だけで', '手首から先だけ', '影をつけずに', '3色以内で'];

// ---- テンプレ出題 ----

/**
 * LLM 不要のテンプレ出題。弱点カテゴリを重み付けしたシード無しランダムで選ぶ。
 * constraints はランダムで 0〜2 個。
 */
export function templatePrompt(stats?: UserStats): Prompt {
  const categories = Object.keys(MOTIFS) as Category[];

  let category: Category;
  if (stats) {
    // 弱点上位2カテゴリの出現重みを増やす（重点出題）。
    const weak = weakestCategories(stats, 2);
    const weighted: Category[] = [...categories, ...weak, ...weak]; // 弱点を3倍相当に
    category = pickRandom(weighted);
  } else {
    category = pickRandom(categories);
  }

  const motif = pickRandom(MOTIFS[category]);

  // constraints 0〜2 個をランダム抽出（重複なし）。
  const nCon = Math.floor(Math.random() * 3);
  const constraints = sampleN(CONSTRAINT_POOL, nCon);

  const text = constraints.length > 0 ? `${motif}（${constraints.join(' / ')}）` : motif;

  return {
    id: `tpl-${crypto.randomUUID()}`,
    source: 'template',
    text,
    category,
    constraints: constraints.length > 0 ? constraints : undefined,
  };
}

// ---- LLM 出題（フォールバック付き）----

export async function generateDrawingPrompt(
  stats: UserStats,
): Promise<{ prompt: Prompt; source: 'llm' | 'template' }> {
  if (getLlmState().status !== 'ready') {
    return { prompt: templatePrompt(stats), source: 'template' };
  }

  const parsed = await runJsonWithRetry(
    () => buildPromptGenMessages(stats),
    (json) => promptGenSchema.safeParse(json),
    256,
  );

  if (!parsed) {
    return { prompt: templatePrompt(stats), source: 'template' };
  }

  const text =
    parsed.constraints.length > 0
      ? `${parsed.motif}（${parsed.constraints.join(' / ')}）`
      : parsed.motif;

  const prompt: Prompt = {
    id: `llm-${crypto.randomUUID()}`,
    source: 'llm',
    text,
    category: parsed.category,
    constraints: parsed.constraints.length > 0 ? parsed.constraints : undefined,
  };
  return { prompt, source: 'llm' };
}

// ---- 3Dアタリ出題（見立て）----

export async function generateMitatePrompt(
  image: HTMLCanvasElement,
  spec: SceneSpec,
): Promise<{ text: string; source: 'llm' | 'template' }> {
  const fallback = { text: 'この3D構図を線画でデッサンしましょう', source: 'template' as const };

  if (getLlmState().status !== 'ready') return fallback;

  const parsed = await runJsonWithRetryImage(
    () => buildMitateMessages(spec),
    image,
    (json) => promptGenSchema.safeParse(json),
    256,
  );

  if (!parsed) return fallback;

  const suffix = parsed.constraints.length > 0 ? `（${parsed.constraints.join(' / ')}）` : '';
  return { text: `${parsed.motif}に見立てて描く${suffix}`, source: 'llm' };
}

// ---- 講評 ----

export async function generateFeedback(
  image: Blob,
  evaluation: Evaluation,
  mode: SessionMode,
): Promise<Evaluation['llmFeedback'] | null> {
  if (getLlmState().status !== 'ready') return null;

  // rubric の整形サマリを import すると循環しないため直接呼ぶ。
  const { formatEvaluationSummary } = await import('../evaluation/rubric.ts');
  const summary = formatEvaluationSummary(evaluation, mode);

  const parsed = await runJsonWithRetryImage(
    () => buildFeedbackMessages(summary),
    image,
    (json) => feedbackSchema.safeParse(json),
    256,
  );

  if (!parsed) return null;
  return { praise: parsed.praise, issue: parsed.issue, nextAction: parsed.nextAction };
}

// ---- JSON 生成 + zod + 1リトライ の共通ロジック（例外は握りつぶす）----

const RETRY_HINT = '\n（重要）有効な JSON のみを出力してください。前後の説明・コードフェンスは不要です。';

type SafeParse<T> = { success: true; data: T } | { success: false };

/** 画像なしバージョン。 */
async function runJsonWithRetry<T>(
  buildMessages: () => import('./messages.ts').ChatMessage[],
  parse: (json: unknown) => SafeParse<T>,
  maxNewTokens: number,
): Promise<T | null> {
  return attemptChain<T>(
    (retry) => generateSafe(buildMessages(), undefined, maxNewTokens, retry),
    parse,
  );
}

/** 画像ありバージョン。 */
async function runJsonWithRetryImage<T>(
  buildMessages: () => import('./messages.ts').ChatMessage[],
  image: Blob | HTMLCanvasElement,
  parse: (json: unknown) => SafeParse<T>,
  maxNewTokens: number,
): Promise<T | null> {
  return attemptChain<T>(
    (retry) => generateSafe(buildMessages(), image, maxNewTokens, retry),
    parse,
  );
}

/** 生成→extractJson→parse を最大2回（初回+1リトライ）試す。全経路で throw しない。 */
async function attemptChain<T>(
  gen: (retry: boolean) => Promise<string | null>,
  parse: (json: unknown) => SafeParse<T>,
): Promise<T | null> {
  for (const retry of [false, true]) {
    const text = await gen(retry);
    if (text == null) continue;
    const json = extractJson(text);
    if (json == null) continue;
    const result = parse(json);
    if (result.success) return result.data;
  }
  return null;
}

/** generateText を try/catch で包み、リトライ時はヒント文を末尾ユーザーメッセージに追記。 */
async function generateSafe(
  messages: import('./messages.ts').ChatMessage[],
  image: Blob | HTMLCanvasElement | undefined,
  maxNewTokens: number,
  retry: boolean,
): Promise<string | null> {
  try {
    const msgs = retry ? appendHint(messages) : messages;
    return await generateText({ messages: msgs, image, maxNewTokens });
  } catch {
    return null;
  }
}

/** 最後の user メッセージにリトライ用ヒントを追記した新配列を返す（元は変更しない）。 */
function appendHint(
  messages: import('./messages.ts').ChatMessage[],
): import('./messages.ts').ChatMessage[] {
  const copy = messages.map((m) => ({ ...m }));
  for (let i = copy.length - 1; i >= 0; i--) {
    if (copy[i].role !== 'user') continue;
    const c = copy[i].content;
    if (typeof c === 'string') {
      copy[i] = { ...copy[i], content: c + RETRY_HINT };
    } else {
      // マルチモーダル: text 部品にヒントを足す（なければ追加）。
      const parts = [...c];
      const lastText = [...parts].reverse().find((p) => p.type === 'text');
      if (lastText && lastText.type === 'text') lastText.text += RETRY_HINT;
      else parts.push({ type: 'text', text: RETRY_HINT.trim() });
      copy[i] = { ...copy[i], content: parts };
    }
    break;
  }
  return copy;
}

// ---- ランダムユーティリティ（シード無し）----

function pickRandom<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function sampleN<T>(arr: T[], n: number): T[] {
  if (n <= 0) return [];
  const pool = [...arr];
  const out: T[] = [];
  for (let i = 0; i < n && pool.length > 0; i++) {
    const idx = Math.floor(Math.random() * pool.length);
    out.push(pool.splice(idx, 1)[0]);
  }
  return out;
}
