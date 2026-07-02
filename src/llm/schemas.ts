// LLM 出力の zod スキーマと頑健な JSON 抽出（SPEC §8: JSON 崩れ対策）。React 非依存。

import { z } from 'zod';
import type { Category } from '../store/types.ts';

// Category 値（store/types.ts と一致させること）。
const CATEGORY_VALUES: [Category, ...Category[]] = [
  'hand',
  'perspective',
  'animal',
  'pose',
  'still',
  'gesture',
  'other',
];

/** 出題 JSON。 */
export const promptGenSchema = z.object({
  motif: z.string().min(1),
  constraints: z.array(z.string()).max(3),
  category: z.enum(CATEGORY_VALUES),
  difficulty: z.number().min(1).max(5),
});
export type PromptGen = z.infer<typeof promptGenSchema>;

/** 講評 JSON（各1項目のみ）。 */
export const feedbackSchema = z.object({
  praise: z.string().min(1),
  issue: z.string().min(1),
  nextAction: z.string().min(1),
});
export type Feedback = z.infer<typeof feedbackSchema>;

/**
 * モデル出力テキストから JSON オブジェクトを頑健に抽出する。
 * - ```json フェンスや ``` フェンスを除去
 * - 最初の '{' から対応する '}' までを括弧の対応を数えて切り出す（文字列内の括弧は無視）
 * 失敗時は null。
 */
export function extractJson(text: string): unknown | null {
  if (!text) return null;

  // コードフェンスを除去（```json ... ``` / ``` ... ```）。
  let s = text.trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();

  // まず全体をそのまま parse してみる。
  const direct = tryParse(s);
  if (direct !== undefined) return direct;

  // '{' から対応する '}' までを括弧カウントで抽出。
  const start = s.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inStr = false;
  let escaped = false;
  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const candidate = s.slice(start, i + 1);
        const parsed = tryParse(candidate);
        return parsed === undefined ? null : parsed;
      }
    }
  }
  return null;
}

function tryParse(s: string): unknown | undefined {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}
