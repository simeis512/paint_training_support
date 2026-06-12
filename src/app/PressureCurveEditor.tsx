// 筆圧レスポンスカーブ（3次ベジェ、端点固定）をSVG上でドラッグ編集するエディタ
import { useCallback, useRef, useState } from 'react';
import type { PressureCurve } from '../store/types';
import { evalPressureCurve } from '../drawing/brush';

type Props = {
  curve: PressureCurve;
  onChange: (curve: PressureCurve) => void;
};

const SIZE = 160; // SVG表示サイズ(px、正方形)
const PADDING = 12;
const INNER = SIZE - PADDING * 2;

/** カーブ座標(0-1) → SVG座標へ変換（y軸は上下反転） */
const toSvg = (x: number, y: number): { x: number; y: number } => ({
  x: PADDING + x * INNER,
  y: PADDING + (1 - y) * INNER,
});

/** SVG座標 → カーブ座標(0-1、クランプ済み) */
const fromSvg = (x: number, y: number): [number, number] => {
  const cx = Math.min(1, Math.max(0, (x - PADDING) / INNER));
  const cy = Math.min(1, Math.max(0, 1 - (y - PADDING) / INNER));
  return [cx, cy];
};

/** プレビュー曲線のパスを生成（evalPressureCurveをサンプリング） */
const buildPreviewPath = (curve: PressureCurve): string => {
  const steps = 32;
  let d = '';
  for (let i = 0; i <= steps; i++) {
    const p = i / steps;
    const v = evalPressureCurve(curve, p);
    const pt = toSvg(p, v);
    d += i === 0 ? `M ${pt.x} ${pt.y}` : ` L ${pt.x} ${pt.y}`;
  }
  return d;
};

export const PressureCurveEditor = ({ curve, onChange }: Props) => {
  const svgRef = useRef<SVGSVGElement>(null);
  const [dragging, setDragging] = useState<'cp1' | 'cp2' | null>(null);

  const updateFromPointer = useCallback(
    (clientX: number, clientY: number, target: 'cp1' | 'cp2') => {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const x = ((clientX - rect.left) / rect.width) * SIZE;
      const y = ((clientY - rect.top) / rect.height) * SIZE;
      const [cx, cy] = fromSvg(x, y);
      if (target === 'cp1') {
        onChange({ cp1: [cx, cy], cp2: curve.cp2 });
      } else {
        onChange({ cp1: curve.cp1, cp2: [cx, cy] });
      }
    },
    [curve, onChange],
  );

  const handlePointerDown = (target: 'cp1' | 'cp2') => (e: React.PointerEvent) => {
    e.preventDefault();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDragging(target);
    updateFromPointer(e.clientX, e.clientY, target);
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!dragging) return;
    updateFromPointer(e.clientX, e.clientY, dragging);
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (!dragging) return;
    (e.target as Element).releasePointerCapture?.(e.pointerId);
    setDragging(null);
  };

  const p1 = toSvg(curve.cp1[0], curve.cp1[1]);
  const p2 = toSvg(curve.cp2[0], curve.cp2[1]);
  const start = toSvg(0, 0);
  const end = toSvg(1, 1);
  const previewPath = buildPreviewPath(curve);

  return (
    <svg
      ref={svgRef}
      className="curve-editor"
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* 背景グリッド */}
      <rect x={PADDING} y={PADDING} width={INNER} height={INNER} className="curve-bg" />
      {/* プレビュー曲線 */}
      <path d={previewPath} className="curve-preview" fill="none" />
      {/* 制御線 */}
      <line x1={start.x} y1={start.y} x2={p1.x} y2={p1.y} className="curve-handle-line" />
      <line x1={end.x} y1={end.y} x2={p2.x} y2={p2.y} className="curve-handle-line" />
      {/* 制御点 */}
      <circle
        cx={p1.x}
        cy={p1.y}
        r={6}
        className="curve-handle"
        onPointerDown={handlePointerDown('cp1')}
      />
      <circle
        cx={p2.x}
        cy={p2.y}
        r={6}
        className="curve-handle"
        onPointerDown={handlePointerDown('cp2')}
      />
    </svg>
  );
};
