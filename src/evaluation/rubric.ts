// 定量評価結果(Evaluation)→LLM入力用テキストサマリ整形（Phase 4 講評プロンプトで使用）。
// LLM には数値そのものではなく言語化された要約を渡す（SPEC §1: 数値判断はアルゴリズム専任）。

import type { Evaluation } from '../store/types.ts';

/** セル座標(row,col 0始まり)を "A1" 形式のラベルに変換（列=A,B,C.../行=1,2,3...） */
function cellLabel(row: number, col: number): string {
  const colLabel = String.fromCharCode(65 + col);
  return `${colLabel}${row + 1}`;
}

/** スコア(0..1)を一致度の言語表現に変換 */
function describeScore(score: number): string {
  if (score >= 0.8) return '形がよく一致';
  if (score >= 0.6) return 'おおむね一致';
  if (score >= 0.4) return '形のずれがやや大きい';
  if (score >= 0.2) return '形のずれが大きい';
  return '形がほとんど一致していない';
}

/** 安定度(0..1)を言語表現に変換 */
function describeStability(stability: number): string {
  if (stability >= 0.8) return '安定している';
  if (stability >= 0.6) return 'やや安定している';
  if (stability >= 0.4) return 'やや不安定（ガタつきあり）';
  return '不安定（線がガタついている）';
}

/** cellScores の中から最もスコアが低いセルを上位 count 件抽出 */
function worstCells(cellScores: number[][], count: number): { label: string; score: number }[] {
  const flat: { label: string; score: number }[] = [];
  for (let row = 0; row < cellScores.length; row++) {
    for (let col = 0; col < cellScores[row].length; col++) {
      flat.push({ label: cellLabel(row, col), score: cellScores[row][col] });
    }
  }
  flat.sort((a, b) => a.score - b.score);
  return flat.slice(0, count);
}

/** 定量結果→LLM入力用テキストサマリ（日本語、簡潔） */
export function formatEvaluationSummary(e: Evaluation, mode: 'gridCopy' | 'primitive3d' | 'free'): string {
  const { quantitative } = e;
  const lines: string[] = [];

  if (mode === 'free') {
    lines.push('モード: フリー描画（形の一致度評価なし）');
  } else {
    const { cellScores } = quantitative;
    if (cellScores && cellScores.length > 0) {
      const overall = average(cellScores.flat());
      const modeLabel = mode === 'gridCopy' ? 'グリッド模写' : '3Dプリミティブ';
      lines.push(`モード: ${modeLabel}`);
      lines.push(`全体スコア: ${(overall * 100).toFixed(0)}点（${describeScore(overall)}）`);

      const worst = worstCells(cellScores, 2).filter((c) => c.score < 0.8);
      if (worst.length > 0) {
        const desc = worst.map((c) => `${c.label}: ${describeScore(c.score)}`).join(' / ');
        lines.push(`特に注意したいセル: ${desc}`);
      } else {
        lines.push('セル別の大きなずれはなし');
      }
    } else {
      lines.push('モード: ' + (mode === 'gridCopy' ? 'グリッド模写' : '3Dプリミティブ') + '（セル評価データなし）');
    }
  }

  lines.push(`線の安定度: ${(quantitative.strokeStability * 100).toFixed(0)}点（${describeStability(quantitative.strokeStability)}）`);

  if (quantitative.perspectiveErrors && quantitative.perspectiveErrors.length > 0) {
    const desc = quantitative.perspectiveErrors
      .map((p) => `${p.edgeId}が${Math.abs(p.degrees).toFixed(0)}°ずれ`)
      .join(' / ');
    lines.push(`パースのずれ: ${desc}`);
  }

  return lines.join('\n');
}

function average(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
