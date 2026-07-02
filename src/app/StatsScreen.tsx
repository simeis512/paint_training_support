// 成績タブ: カテゴリ別EMAレーダーチャート(SVG自前実装) + ストリーク + XP/レベル + 総セッション数
import { useEffect, useState } from 'react';
import { getUserStats, listSessionSummaries } from '../store/db';
import { effectiveStreak } from '../progression/streak';
import { levelForXp } from '../progression/xp';
import type { Category, UserStats } from '../store/types';
import { SESSION_SAVED_EVENT } from './StreakBadge';
import './StatsScreen.css';

/** types.ts の Category 全種（表示順を固定するためここで列挙） */
const CATEGORIES: { value: Category; label: string }[] = [
  { value: 'hand', label: '手' },
  { value: 'perspective', label: 'パース' },
  { value: 'animal', label: '動物' },
  { value: 'pose', label: 'ポーズ' },
  { value: 'still', label: '静物' },
  { value: 'gesture', label: 'ジェスチャー' },
  { value: 'other', label: 'その他' },
];

const CHART_SIZE = 320;
const CENTER = CHART_SIZE / 2;
const RADIUS = CHART_SIZE / 2 - 48;
const RINGS = 4;

/** 中心からの角度・半径からSVG座標を求める(0番目軸を真上に配置) */
const axisPoint = (index: number, count: number, radius: number): [number, number] => {
  const angle = (Math.PI * 2 * index) / count - Math.PI / 2;
  return [CENTER + radius * Math.cos(angle), CENTER + radius * Math.sin(angle)];
};

const polygonPoints = (values: number[]): string =>
  values.map((v, i) => axisPoint(i, values.length, RADIUS * Math.max(0, Math.min(1, v))).join(',')).join(' ');

export const StatsScreen = () => {
  const [stats, setStats] = useState<UserStats | null>(null);
  const [sessionCount, setSessionCount] = useState(0);

  const reload = () => {
    void getUserStats().then(setStats);
    void listSessionSummaries().then((list) => setSessionCount(list.length));
  };

  useEffect(() => {
    reload();
    window.addEventListener(SESSION_SAVED_EVENT, reload);
    return () => window.removeEventListener(SESSION_SAVED_EVENT, reload);
  }, []);

  if (!stats) return <p className="stats-empty">読み込み中...</p>;

  const streak = effectiveStreak(stats.streak);
  const level = levelForXp(stats.xp);
  const levelProgressPercent = Math.round((level.currentXp / level.nextLevelXp) * 100);

  const values = CATEGORIES.map((c) => stats.categoryScores[c.value]?.ema ?? 0);

  // 弱点カテゴリ（データありのうちEMA低い順上位2）
  const weakCategories = CATEGORIES
    .filter((c) => stats.categoryScores[c.value] !== undefined)
    .sort((a, b) => (stats.categoryScores[a.value]?.ema ?? 0) - (stats.categoryScores[b.value]?.ema ?? 0))
    .slice(0, 2);

  return (
    <div className="stats-screen">
      <div className="stats-summary-row">
        <div className="stats-card">
          <span className="stats-card-label">ストリーク</span>
          <span className="stats-card-value">🔥 {streak.current}</span>
          <span className="stats-card-sub">最高 {streak.best}日</span>
        </div>

        <div className="stats-card">
          <span className="stats-card-label">レベル</span>
          <span className="stats-card-value">Lv.{level.level}</span>
          <div className="stats-level-bar">
            <div className="stats-level-fill" style={{ width: `${levelProgressPercent}%` }} />
          </div>
          <span className="stats-card-sub">
            {Math.floor(level.currentXp)} / {level.nextLevelXp} XP
          </span>
        </div>

        <div className="stats-card">
          <span className="stats-card-label">総セッション数</span>
          <span className="stats-card-value">{sessionCount}</span>
        </div>
      </div>

      <div className="stats-radar-wrap">
        <h2>カテゴリ別スコア</h2>
        <svg viewBox={`0 0 ${CHART_SIZE} ${CHART_SIZE}`} className="stats-radar-svg">
          {/* 同心グリッド */}
          {Array.from({ length: RINGS }, (_, ring) => {
            const r = (RADIUS * (ring + 1)) / RINGS;
            const points = CATEGORIES.map((_, i) => axisPoint(i, CATEGORIES.length, r).join(',')).join(' ');
            return <polygon key={ring} points={points} className="stats-radar-grid" />;
          })}

          {/* 軸線 */}
          {CATEGORIES.map((c, i) => {
            const [x, y] = axisPoint(i, CATEGORIES.length, RADIUS);
            return <line key={c.value} x1={CENTER} y1={CENTER} x2={x} y2={y} className="stats-radar-axis" />;
          })}

          {/* データポリゴン */}
          <polygon points={polygonPoints(values)} className="stats-radar-data" />
          {values.map((v, i) => {
            const [x, y] = axisPoint(i, CATEGORIES.length, RADIUS * Math.max(0, Math.min(1, v)));
            return <circle key={CATEGORIES[i].value} cx={x} cy={y} r={3} className="stats-radar-point" />;
          })}

          {/* ラベル */}
          {CATEGORIES.map((c, i) => {
            const [x, y] = axisPoint(i, CATEGORIES.length, RADIUS + 24);
            const ema = stats.categoryScores[c.value]?.ema;
            return (
              <text key={c.value} x={x} y={y} className="stats-radar-label" textAnchor="middle" dominantBaseline="middle">
                {c.label}
                {ema !== undefined ? ` ${Math.round(ema * 100)}%` : ''}
              </text>
            );
          })}
        </svg>
      </div>

      <p className="stats-weak-note">
        弱点カテゴリ（EMA低い順上位2）は出題で優先されます。
        {weakCategories.length > 0 && (
          <>
            {' '}現在:{' '}
            {weakCategories
              .map((c) => `${c.label}（${Math.round((stats.categoryScores[c.value]?.ema ?? 0) * 100)}%）`)
              .join('、')}
          </>
        )}
      </p>
    </div>
  );
};
