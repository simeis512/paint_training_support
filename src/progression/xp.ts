// XP・レベル。docs/SPEC.md §5 P1-2 継続系の一部（軽量実装でよい）。

const BASE_XP = 10;
const OVERALL_XP_MULTIPLIER = 20;
const DAILY_BONUS_XP = 10;

/** 保存1回のXP: 基本10 + overall評価×20（評価なしは+0）+ デイリーボーナス10。整数に丸める */
export function xpForSession(overall: number | null, isDaily: boolean): number {
  const overallXp = overall !== null ? overall * OVERALL_XP_MULTIPLIER : 0;
  const dailyBonus = isDaily ? DAILY_BONUS_XP : 0;
  return Math.round(BASE_XP + overallXp + dailyBonus);
}

/** レベル曲線: 次レベル必要XP = 100 × level */
export function levelForXp(xp: number): { level: number; currentXp: number; nextLevelXp: number } {
  let level = 1;
  let remaining = xp;
  let requiredForLevel = 100 * level;

  while (remaining >= requiredForLevel) {
    remaining -= requiredForLevel;
    level += 1;
    requiredForLevel = 100 * level;
  }

  return { level, currentXp: remaining, nextLevelXp: requiredForLevel };
}
