// ヘッダー用ストリーク表示。docs/SPEC.md §5 P1-2「ストリーク表示」に対応。
// 保存成功イベント（al:session-saved）で再取得する。
import { useEffect, useState } from 'react';
import { checkAndAdvanceStreak, effectiveStreak } from '../progression/streak';
import { todayKey } from '../progression/daily';
import type { DailyGoalProgress } from '../progression/streak';
import './StreakBadge.css';

export const SESSION_SAVED_EVENT = 'al:session-saved';

export const StreakBadge = () => {
  const [streak, setStreak] = useState<{ current: number; best: number } | null>(null);
  const [progress, setProgress] = useState<DailyGoalProgress | null>(null);
  // 再取得トリガー（マウント時 + al:session-saved イベントでインクリメント）
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    const onSaved = () => setReloadToken((t) => t + 1);
    window.addEventListener(SESSION_SAVED_EVENT, onSaved);
    return () => window.removeEventListener(SESSION_SAVED_EVENT, onSaved);
  }, []);

  useEffect(() => {
    let cancelled = false;
    // checkAndAdvanceStreak は目標未達なら何もせず現状を返すだけなので毎回呼んでよい
    void checkAndAdvanceStreak().then(({ streak: rawStreak, progress: p }) => {
      if (cancelled) return;
      setStreak(effectiveStreak(rawStreak, todayKey()));
      setProgress(p);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  // getUserStats 初回未保存時は effectiveStreak が current:0 を返すのでそのまま表示可
  if (!streak || !progress) return null;

  const goalLabel = progress.dailyDone
    ? 'デイリー 済'
    : `ジェスチャー ${progress.gestureCount}/3`;

  return (
    <div className="streak-badge" title={`最高記録: ${streak.best}日`}>
      <span className="streak-fire">🔥</span>
      <span className="streak-current">{streak.current}</span>
      <span className="streak-best">/{streak.best}</span>
      <span className="streak-goal">
        今日: {goalLabel}
        {progress.goalMet && <span className="streak-goal-check"> ✓</span>}
      </span>
    </div>
  );
};
