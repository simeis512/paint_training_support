// 再戦システム。docs/SPEC.md §5 P1-2「再戦システム」に対応。

import type { SessionSummary } from '../store/db';

const RECOMMEND_TARGET_DAYS = 30;
const RECOMMEND_TOLERANCE_DAYS = 5;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export type RematchCandidate = { session: SessionSummary; ageDays: number };

/**
 * 全セッションから再戦候補を返す純関数。
 * 30日前±5日を「おすすめ」先頭に、それ以外は古い順（others）
 */
export function findRematchCandidates(
  summaries: SessionSummary[],
  now: Date = new Date(),
): { recommended: RematchCandidate[]; others: RematchCandidate[] } {
  const nowMs = now.getTime();

  const candidates: RematchCandidate[] = summaries.map((session) => ({
    session,
    ageDays: (nowMs - session.startedAt) / MS_PER_DAY,
  }));

  const recommended: RematchCandidate[] = [];
  const others: RematchCandidate[] = [];

  for (const candidate of candidates) {
    const diff = Math.abs(candidate.ageDays - RECOMMEND_TARGET_DAYS);
    if (diff <= RECOMMEND_TOLERANCE_DAYS) {
      recommended.push(candidate);
    } else {
      others.push(candidate);
    }
  }

  // おすすめは30日前に近い順、それ以外は古い順（ageDaysが大きい順）
  recommended.sort(
    (a, b) => Math.abs(a.ageDays - RECOMMEND_TARGET_DAYS) - Math.abs(b.ageDays - RECOMMEND_TARGET_DAYS),
  );
  others.sort((a, b) => b.ageDays - a.ageDays);

  return { recommended, others };
}
