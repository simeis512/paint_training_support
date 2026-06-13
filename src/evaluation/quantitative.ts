// 定量評価コア。LLM を介さず数値で「参照との一致度」「線の安定度」を算出する（SPEC §1, §5 P0-4）。
// Reactや外部ライブラリへの依存なし。ImageData(Canvas 2D)と Stroke 配列のみを入力とする。

import type { Stroke } from '../store/types.ts';

// ============================================================
// エッジマップ生成（グレースケール化 + Sobel）
// ============================================================

export type EdgeMap = { data: Float32Array; width: number; height: number };

/** RGBA 画素をグレースケール輝度(0..255)に変換。アルファは白背景に合成して扱う（透明=白） */
function toGrayscale(data: Uint8ClampedArray, width: number, height: number): Float32Array {
  const gray = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const a = data[o + 3] / 255;
    // 透明部分は白(255)とブレンド = 背景は白いキャンバスとみなす
    const r = data[o] * a + 255 * (1 - a);
    const g = data[o + 1] * a + 255 * (1 - a);
    const b = data[o + 2] * a + 255 * (1 - a);
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return gray;
}

/** 端は同じ値を繰り返すクランプでサンプリング（境界での誤検出を避ける） */
function sampleClamped(gray: Float32Array, width: number, height: number, x: number, y: number): number {
  const cx = Math.min(Math.max(x, 0), width - 1);
  const cy = Math.min(Math.max(y, 0), height - 1);
  return gray[cy * width + cx];
}

/** Sobel 勾配の最大値で正規化する係数（|Gx|,|Gy| それぞれ最大 4*255、合成最大 4*255*sqrt2） */
const SOBEL_MAX = 4 * 255 * Math.SQRT2;

/** グレースケール化 + Sobel でエッジ強度マップ(0..1)を返す */
export function computeEdgeMap(img: ImageData): EdgeMap {
  const { width, height, data } = img;
  const gray = toGrayscale(data, width, height);
  const out = new Float32Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const tl = sampleClamped(gray, width, height, x - 1, y - 1);
      const t = sampleClamped(gray, width, height, x, y - 1);
      const tr = sampleClamped(gray, width, height, x + 1, y - 1);
      const l = sampleClamped(gray, width, height, x - 1, y);
      const r = sampleClamped(gray, width, height, x + 1, y);
      const bl = sampleClamped(gray, width, height, x - 1, y + 1);
      const b = sampleClamped(gray, width, height, x, y + 1);
      const br = sampleClamped(gray, width, height, x + 1, y + 1);

      const gx = (tr + 2 * r + br) - (tl + 2 * l + bl);
      const gy = (bl + 2 * b + br) - (tl + 2 * t + tr);
      const mag = Math.sqrt(gx * gx + gy * gy);
      out[y * width + x] = Math.min(1, mag / SOBEL_MAX);
    }
  }
  return { data: out, width, height };
}

// ============================================================
// 共通ユーティリティ: リサンプル・2値化・膨張
// ============================================================

/** ImageData を bilinear で targetWidth×targetHeight にリサンプル */
function resampleImageData(img: ImageData, targetWidth: number, targetHeight: number): ImageData {
  const { width: sw, height: sh, data: src } = img;
  if (sw === targetWidth && sh === targetHeight) return img;

  const dst = new Uint8ClampedArray(targetWidth * targetHeight * 4);
  const sx = sw / targetWidth;
  const sy = sh / targetHeight;

  for (let y = 0; y < targetHeight; y++) {
    const fy = (y + 0.5) * sy - 0.5;
    const y0 = Math.floor(fy);
    const wy = fy - y0;
    const y0c = Math.min(Math.max(y0, 0), sh - 1);
    const y1c = Math.min(Math.max(y0 + 1, 0), sh - 1);

    for (let x = 0; x < targetWidth; x++) {
      const fx = (x + 0.5) * sx - 0.5;
      const x0 = Math.floor(fx);
      const wx = fx - x0;
      const x0c = Math.min(Math.max(x0, 0), sw - 1);
      const x1c = Math.min(Math.max(x0 + 1, 0), sw - 1);

      const di = (y * targetWidth + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = src[(y0c * sw + x0c) * 4 + c];
        const v10 = src[(y0c * sw + x1c) * 4 + c];
        const v01 = src[(y1c * sw + x0c) * 4 + c];
        const v11 = src[(y1c * sw + x1c) * 4 + c];
        const v0 = v00 * (1 - wx) + v10 * wx;
        const v1 = v01 * (1 - wx) + v11 * wx;
        dst[di + c] = v0 * (1 - wy) + v1 * wy;
      }
    }
  }
  return { data: dst, width: targetWidth, height: targetHeight, colorSpace: img.colorSpace } as ImageData;
}

/** エッジ強度マップを閾値で2値化（true=エッジ） */
function binarize(edge: EdgeMap, threshold: number): Uint8Array {
  const out = new Uint8Array(edge.width * edge.height);
  for (let i = 0; i < out.length; i++) out[i] = edge.data[i] >= threshold ? 1 : 0;
  return out;
}

/** 2値マスクを radius px 分膨張（正方形カーネル、行→列の分離可能フィルタで近似） */
function dilate(mask: Uint8Array, width: number, height: number, radius: number): Uint8Array {
  if (radius <= 0) return mask;
  const tmp = new Uint8Array(width * height);
  // 横方向
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dx = -radius; dx <= radius && !v; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < width && mask[y * width + xx]) v = 1;
      }
      tmp[y * width + x] = v;
    }
  }
  // 縦方向
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 0;
      for (let dy = -radius; dy <= radius && !v; dy++) {
        const yy = y + dy;
        if (yy >= 0 && yy < height && tmp[yy * width + x]) v = 1;
      }
      out[y * width + x] = v;
    }
  }
  return out;
}

// ============================================================
// グリッド比較コア
// ============================================================

export type GridEvalResult = {
  /** n×n、0..1（1=よく一致） */
  cellScores: number[][];
  /** n×n、セル内エッジ重心のずれ（セルサイズで正規化、参照-描画） */
  centroidOffsets: [number, number][][];
  /** cellScores の重み付き平均 0..1 */
  overall: number;
};

/** セルの矩形範囲 [x0,x1) × [y0,y1) を計算 */
function cellBounds(width: number, height: number, n: number, cx: number, cy: number) {
  const x0 = Math.floor((cx * width) / n);
  const x1 = Math.floor(((cx + 1) * width) / n);
  const y0 = Math.floor((cy * height) / n);
  const y1 = Math.floor(((cy + 1) * height) / n);
  return { x0, x1, y0, y1 };
}

/** マスク膨張の半径(px)。セルサイズに対しおおよそ8%程度の許容ずれとする */
function dilationRadius(width: number, height: number, n: number): number {
  const cell = Math.min(width / n, height / n);
  return Math.max(1, Math.round(cell * 0.08));
}

/** エッジ2値化の閾値。Sobel 正規化値はノイズが乗りやすいため低めに設定 */
const EDGE_THRESHOLD = 0.15;

/**
 * 参照エッジマップ・描画エッジマップ（同寸、同 n）からグリッド評価を行う共通ロジック。
 * evaluateGridCopy / evaluate3D の両方から使う。
 */
function compareEdgeMaps(refEdge: EdgeMap, drawEdge: EdgeMap, n: number): GridEvalResult {
  const { width, height } = refEdge;
  const refMask = binarize(refEdge, EDGE_THRESHOLD);
  const drawMask = binarize(drawEdge, EDGE_THRESHOLD);
  const radius = dilationRadius(width, height, n);
  const refDilated = dilate(refMask, width, height, radius);
  const drawDilated = dilate(drawMask, width, height, radius);

  const cellScores: number[][] = [];
  const centroidOffsets: [number, number][][] = [];
  let weightedSum = 0;
  let weightTotal = 0;

  for (let cy = 0; cy < n; cy++) {
    const scoreRow: number[] = [];
    const offsetRow: [number, number][] = [];
    for (let cx = 0; cx < n; cx++) {
      const { x0, x1, y0, y1 } = cellBounds(width, height, n, cx, cy);
      const cellW = Math.max(1, x1 - x0);
      const cellH = Math.max(1, y1 - y0);
      const cellArea = cellW * cellH;

      let refCount = 0;
      let drawCount = 0;
      let refOverlapInDrawDilated = 0; // ref エッジのうち drawDilated に含まれる数
      let drawOverlapInRefDilated = 0; // draw エッジのうち refDilated に含まれる数
      let refEdgeSum = 0;
      let drawEdgeSum = 0;
      let refCx = 0;
      let refCy = 0;
      let drawCx = 0;
      let drawCy = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const idx = y * width + x;
          const re = refEdge.data[idx];
          const de = drawEdge.data[idx];

          if (refMask[idx]) {
            refCount++;
            if (drawDilated[idx]) refOverlapInDrawDilated++;
          }
          if (drawMask[idx]) {
            drawCount++;
            if (refDilated[idx]) drawOverlapInRefDilated++;
          }

          // 重心はエッジ強度で重み付け（セル原点基準の相対座標）
          const lx = x - x0;
          const ly = y - y0;
          refEdgeSum += re;
          drawEdgeSum += de;
          refCx += re * lx;
          refCy += re * ly;
          drawCx += de * lx;
          drawCy += de * ly;
        }
      }

      const refDensity = refCount / cellArea;
      const drawDensity = drawCount / cellArea;

      let score: number;
      if (refCount === 0) {
        // 参照側にエッジが無いセルはスコア対象外（白紙提出を不当に救わないよう中立0.5にしない）
        score = 1.0;
      } else {
        // (a) エッジ密度の一致度
        const densityScore = 1 - Math.min(1, Math.abs(refDensity - drawDensity) / refDensity);
        // (b) chamfer近似: 互いに膨張させたマスクへの包含率(precision/recall)のF1
        const precision = drawCount > 0 ? drawOverlapInRefDilated / drawCount : 0;
        const recall = refOverlapInDrawDilated / refCount;
        const overlapScore = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
        score = 0.4 * densityScore + 0.6 * overlapScore;
      }
      scoreRow.push(score);

      // 重み: 参照エッジ密度が高いセルほど評価に寄与する（白紙セルは重み≈0）
      const weight = refDensity;
      weightedSum += score * weight;
      weightTotal += weight;

      // 重心オフセット（セルサイズで正規化、参照-描画）。参照側にエッジがなければ[0,0]
      let offset: [number, number] = [0, 0];
      if (refEdgeSum > 0) {
        const refCentroidX = refCx / refEdgeSum / cellW;
        const refCentroidY = refCy / refEdgeSum / cellH;
        if (drawEdgeSum > 0) {
          const drawCentroidX = drawCx / drawEdgeSum / cellW;
          const drawCentroidY = drawCy / drawEdgeSum / cellH;
          offset = [refCentroidX - drawCentroidX, refCentroidY - drawCentroidY];
        } else {
          // 描画側にエッジが無い場合、セル中心(0.5,0.5)を基準にずれを計算
          offset = [refCentroidX - 0.5, refCentroidY - 0.5];
        }
      }
      offsetRow.push(offset);
    }
    cellScores.push(scoreRow);
    centroidOffsets.push(offsetRow);
  }

  // 全セルが白紙参照（重み0）の場合は単純平均にフォールバック
  const overall = weightTotal > 0 ? weightedSum / weightTotal : 1.0;

  return { cellScores, centroidOffsets, overall };
}

/** 参照とユーザー絵（同寸でなくてよい→内部で描画側を参照寸法にリサンプル）を n×n セルで比較 */
export function evaluateGridCopy(reference: ImageData, drawing: ImageData, n: number): GridEvalResult {
  const resampledDrawing = resampleImageData(drawing, reference.width, reference.height);
  const refEdge = computeEdgeMap(reference);
  const drawEdge = computeEdgeMap(resampledDrawing);
  return compareEdgeMaps(refEdge, drawEdge, n);
}

/** 3Dモード: 正解エッジマップ（黒=線の RGBA、scene3d/groundTruth.ts の形式）とユーザー絵のエッジ差分 */
export function evaluate3D(
  groundTruthEdge: { data: Uint8ClampedArray; width: number; height: number },
  drawing: ImageData,
  n: number,
): GridEvalResult {
  const { width, height, data } = groundTruthEdge;
  // 黒=線のRGBA画像をエッジ強度(0..1, 黒いほど1)に変換
  const refEdgeData = new Float32Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4;
    const luminance = 0.299 * data[o] + 0.587 * data[o + 1] + 0.114 * data[o + 2];
    refEdgeData[i] = 1 - luminance / 255;
  }
  const refEdge: EdgeMap = { data: refEdgeData, width, height };

  const resampledDrawing = resampleImageData(drawing, width, height);
  const drawEdge = computeEdgeMap(resampledDrawing);
  return compareEdgeMaps(refEdge, drawEdge, n);
}

// ============================================================
// ストローク安定度
// ============================================================

/** 安定度計算の対象とする最小点数（少なすぎる点列は速度分散が信頼できない） */
const MIN_POINTS_FOR_STABILITY = 4;

/** ストローク速度分散から線の安定度 0..1（高い=安定）。点が少ないストロークは除外 */
export function strokeStability(strokes: Stroke[]): number {
  const stabilities: number[] = [];

  for (const stroke of strokes) {
    const pts = stroke.points;
    if (pts.length < MIN_POINTS_FOR_STABILITY) continue;

    const speeds: number[] = [];
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x;
      const dy = pts[i].y - pts[i - 1].y;
      const dt = Math.max(pts[i].t - pts[i - 1].t, 1e-3);
      const dist = Math.sqrt(dx * dx + dy * dy);
      speeds.push(dist / dt);
    }
    if (speeds.length === 0) continue;

    const mean = speeds.reduce((a, b) => a + b, 0) / speeds.length;
    if (mean <= 1e-6) {
      // ほぼ動いていない（点が重なっている）= 安定とみなす
      stabilities.push(1);
      continue;
    }
    const variance = speeds.reduce((a, b) => a + (b - mean) ** 2, 0) / speeds.length;
    const cv = Math.sqrt(variance) / mean; // 変動係数
    // CV=0で1、CVが大きいほど0に近づく
    stabilities.push(1 / (1 + cv));
  }

  if (stabilities.length === 0) return 1.0;
  return stabilities.reduce((a, b) => a + b, 0) / stabilities.length;
}
