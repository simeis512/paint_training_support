// 評価結果の共通表示コンポーネント。ユーザーの絵にセル別スコアのヒートマップを重ねて表示する。
import { useEffect, useRef } from 'react';
import type { GridEvalResult } from '../evaluation/quantitative';
import './EvaluationView.css';

type Props = {
  result: GridEvalResult;
  stability: number;
  image: Blob | HTMLCanvasElement | null;
};

/** score(0-1) を hsl の hue 0(赤)〜120(緑) にマップした半透明色を返す */
const scoreToColor = (score: number, alpha: number): string => {
  const clamped = Math.min(1, Math.max(0, score));
  const hue = clamped * 120;
  return `hsla(${hue}, 80%, 50%, ${alpha})`;
};

export const EvaluationView = ({ result, stability, image }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // ヒートマップ描画（背景画像 + セル別スコアの半透明オーバーレイ + スコア表示）
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const n = result.cellScores.length;
    if (n === 0) return;

    let cancelled = false;
    let bitmap: ImageBitmap | null = null;

    const draw = (bg: CanvasImageSource | null, w: number, h: number) => {
      canvas.width = w;
      canvas.height = h;
      ctx.clearRect(0, 0, w, h);

      if (bg) {
        ctx.drawImage(bg, 0, 0, w, h);
      } else {
        ctx.fillStyle = '#2a2c33';
        ctx.fillRect(0, 0, w, h);
      }

      const cellW = w / n;
      const cellH = h / n;
      const fontSize = Math.max(10, Math.min(cellW, cellH) / 4);

      for (let row = 0; row < n; row++) {
        for (let col = 0; col < n; col++) {
          const score = result.cellScores[row][col];
          const x = col * cellW;
          const y = row * cellH;

          ctx.fillStyle = scoreToColor(score, 0.45);
          ctx.fillRect(x, y, cellW, cellH);

          ctx.strokeStyle = 'rgba(255, 255, 255, 0.3)';
          ctx.lineWidth = 1;
          ctx.strokeRect(x, y, cellW, cellH);

          ctx.fillStyle = '#ffffff';
          ctx.font = `${fontSize}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(`${Math.round(score * 100)}%`, x + cellW / 2, y + cellH / 2);
        }
      }
    };

    if (image instanceof HTMLCanvasElement) {
      draw(image, image.width, image.height);
    } else if (image instanceof Blob) {
      void createImageBitmap(image).then((bmp) => {
        if (cancelled) {
          bmp.close();
          return;
        }
        bitmap = bmp;
        draw(bmp, bmp.width, bmp.height);
      });
    } else {
      draw(null, 400, 400);
    }

    return () => {
      cancelled = true;
      bitmap?.close();
    };
  }, [result, image]);

  const overallPercent = Math.round(result.overall * 100);
  const stabilityPercent = Math.round(stability * 100);

  return (
    <div className="evaluation-view">
      <div className="evaluation-canvas-wrap">
        <canvas ref={canvasRef} className="evaluation-canvas" />
      </div>
      <div className="evaluation-scores">
        <div className="evaluation-score-main">
          <span className="evaluation-score-label">全体スコア</span>
          <span className="evaluation-score-value">{overallPercent}%</span>
        </div>
        <div className="evaluation-score-sub">
          <span className="evaluation-score-label">線の安定度</span>
          <span className="evaluation-score-value-sub">{stabilityPercent}%</span>
        </div>
      </div>
    </div>
  );
};
