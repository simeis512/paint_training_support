// ストローク点列のバイナリパック/アンパック（docs/SPEC.md §8: IndexedDB容量対策）
// 点ごとに x,y,p,t の4要素を1本の Float32Array に連結して保存する。

import type { Stroke, StrokePoint } from './types';

/** パック後のストロークメタ情報（点列以外の情報 + 点数） */
export type StrokeMeta = {
  brushId: string;
  color: string;
  pointCount: number;
};

/** パック結果。meta はストロークごとの付帯情報、buffer は全点列を連結したバイナリ */
export type PackedStrokes = {
  meta: StrokeMeta[];
  buffer: ArrayBuffer;
};

const FIELDS_PER_POINT = 4; // x, y, p, t

/** ストローク配列を Float32Array バイナリ + メタ情報にパックする */
export function packStrokes(strokes: Stroke[]): PackedStrokes {
  const meta: StrokeMeta[] = strokes.map((s) => ({
    brushId: s.brushId,
    color: s.color,
    pointCount: s.points.length,
  }));

  const totalPoints = meta.reduce((sum, m) => sum + m.pointCount, 0);
  const float32 = new Float32Array(totalPoints * FIELDS_PER_POINT);

  let offset = 0;
  for (const stroke of strokes) {
    for (const point of stroke.points) {
      float32[offset] = point.x;
      float32[offset + 1] = point.y;
      float32[offset + 2] = point.p;
      float32[offset + 3] = point.t;
      offset += FIELDS_PER_POINT;
    }
  }

  return { meta, buffer: float32.buffer };
}

/** meta + buffer からストローク配列に復元する */
export function unpackStrokes(meta: StrokeMeta[], buffer: ArrayBuffer): Stroke[] {
  const float32 = new Float32Array(buffer);

  const strokes: Stroke[] = [];
  let offset = 0;
  for (const m of meta) {
    const points: StrokePoint[] = new Array(m.pointCount);
    for (let i = 0; i < m.pointCount; i++) {
      const base = offset + i * FIELDS_PER_POINT;
      points[i] = {
        x: float32[base],
        y: float32[base + 1],
        p: float32[base + 2],
        t: float32[base + 3],
      };
    }
    offset += m.pointCount * FIELDS_PER_POINT;

    strokes.push({ points, brushId: m.brushId, color: m.color });
  }

  return strokes;
}
