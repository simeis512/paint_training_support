// ストリーク管理。docs/SPEC.md §5 P1-2「ストリーク表示」に対応。途切れ猶予なしのシンプル仕様。

import { todayKey } from './daily';
import { listSessionSummaries, getPrompt, getUserStats, saveUserStats } from '../store/db';
import type { Category, Prompt, UserStats } from '../store/types';

/** 目標: ジェスチャー3枚 or デイリー1枚 */
const GESTURE_GOAL_COUNT = 3;

export type DailyGoalProgress = {
  gestureCount: number;
  dailyDone: boolean;
  goalMet: boolean;
};

/** 今日のセッション（promptのcategory/source解決済み）から進捗を判定する純関数 */
export function computeDailyGoal(
  todaySessions: { category: Category | null; promptSource: Prompt['source'] | null }[],
): DailyGoalProgress {
  const gestureCount = todaySessions.filter((s) => s.category === 'gesture').length;
  const dailyDone = todaySessions.some((s) => s.promptSource === 'daily');
  const goalMet = gestureCount >= GESTURE_GOAL_COUNT || dailyDone;

  return { gestureCount, dailyDone, goalMet };
}

/**
 * 目標達成時にストリークを更新した新しい streak を返す純関数。
 * lastDate === 今日 → 変化なし / lastDate === 昨日 → current+1 / それ以外 → 1 にリセット。best も更新
 */
export function advanceStreak(streak: UserStats['streak'], dateKey: string): UserStats['streak'] {
  if (streak.lastDate === dateKey) {
    return streak;
  }

  const yesterday = dateKeyOffset(dateKey, -1);
  const nextCurrent = streak.lastDate === yesterday ? streak.current + 1 : 1;

  return {
    current: nextCurrent,
    best: Math.max(streak.best, nextCurrent),
    lastDate: dateKey,
  };
}

/** 表示用: lastDate が今日でも昨日でもなければ current を 0 として返す（保存はしない） */
export function effectiveStreak(
  streak: UserStats['streak'],
  dateKey: string = todayKey(),
): { current: number; best: number } {
  const yesterday = dateKeyOffset(dateKey, -1);
  if (streak.lastDate === dateKey || streak.lastDate === yesterday) {
    return { current: streak.current, best: streak.best };
  }
  return { current: 0, best: streak.best };
}

/** 'YYYY-MM-DD' に days 日分オフセットした日付キーを返す（ローカルタイム基準） */
function dateKeyOffset(dateKey: string, days: number): string {
  const [y, m, d] = dateKey.split('-').map(Number);
  const date = new Date(y, m - 1, d);
  date.setDate(date.getDate() + days);
  return todayKey(date);
}

/**
 * db連携ヘルパ: 今日のセッション一覧を解決し、目標達成なら stats.streak を更新して保存。
 * 更新後の値と進捗を返す
 */
export async function checkAndAdvanceStreak(): Promise<{
  streak: UserStats['streak'];
  progress: DailyGoalProgress;
}> {
  const dateKey = todayKey();
  const [y, m, d] = dateKey.split('-').map(Number);
  const startOfDay = new Date(y, m - 1, d).getTime();
  const endOfDay = startOfDay + 24 * 60 * 60 * 1000;

  const summaries = await listSessionSummaries();
  const todaySummaries = summaries.filter(
    (s) => s.startedAt >= startOfDay && s.startedAt < endOfDay,
  );

  const resolved = await Promise.all(
    todaySummaries.map(async (s) => {
      const prompt = await getPrompt(s.promptId);
      return {
        category: prompt?.category ?? null,
        promptSource: prompt?.source ?? null,
      };
    }),
  );

  const progress = computeDailyGoal(resolved);

  const stats = await getUserStats();
  const streak = progress.goalMet ? advanceStreak(stats.streak, dateKey) : stats.streak;

  if (progress.goalMet && streak !== stats.streak) {
    await saveUserStats({ ...stats, streak });
  }

  return { streak, progress };
}
