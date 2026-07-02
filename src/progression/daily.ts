// デイリーお題。docs/SPEC.md §5 P1-2「デイリーシード」に対応。
// 日付から決定論的に生成するため、全ユーザー・同日中は同一お題になる。

import type { Difficulty } from '../scene3d/generator';
import type { Prompt } from '../store/types';
import { createRng, rangeInt } from '../scene3d/random';

/** ローカルタイムの日付キー 'YYYY-MM-DD' */
export function todayKey(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 日付キー → 決定論的シード（FNV-1a ハッシュ）。全ユーザー共通・同日中は不変 */
export function dailySeed(dateKey: string): number {
  let hash = 0x811c9dc5; // FNV offset basis (32bit)
  for (let i = 0; i < dateKey.length; i++) {
    hash ^= dateKey.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return hash >>> 0;
}

/** 日付キー → デイリー難易度（1〜3をシードから決定論的に決定） */
export function dailyDifficulty(dateKey: string): Difficulty {
  const rng = createRng(dailySeed(dateKey));
  return rangeInt(rng, 1, 3) as Difficulty;
}

/** デイリーPromptを生成する。3Dシーンのシードはデイリーシードをそのまま用いる */
export function dailyPrompt(dateKey: string = todayKey()): Prompt {
  const seed = dailySeed(dateKey);
  const difficulty = dailyDifficulty(dateKey);

  return {
    id: `daily-${dateKey}`,
    source: 'daily',
    text: `本日のお題（${dateKey}）: 提示された立体構成を観察して描いてみましょう`,
    category: 'perspective',
    scene3dSeed: seed,
    constraints: [`難易度${difficulty}`],
  };
}
