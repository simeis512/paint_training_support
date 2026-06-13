// 4点射影変換（台形補正）。DLT（Direct Linear Transform）でホモグラフィ行列を求め、
// 逆方向マッピング（出力ピクセル→入力座標）+ バイリニア補間で矩形画像を生成する。
// 数学ライブラリは使わず、8連立一次方程式をガウス消去で解く自前実装。

/** quad は [左上, 右上, 右下, 左下] の順の4点（src画像のピクセル座標） */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

/**
 * 出力矩形（0,0)-(dstW,dstH)）の座標を src 画像上の座標へ写すホモグラフィ行列を求める。
 * 戻り値は 3x3 行列を row-major で並べた長さ9の配列（h[8]=1 に正規化済み）。
 *
 * 解法: 出力矩形の4隅 (0,0),(dstW,0),(dstW,dstH),(0,dstH) を srcQuad の4隅へ写す
 * 射影変換 H を DLT で求める。各対応点から
 *   x' = (h0*x + h1*y + h2) / (h6*x + h7*y + 1)
 *   y' = (h3*x + h4*y + h5) / (h6*x + h7*y + 1)
 * という関係から、未知数 h0..h7（h8=1）についての線形方程式を2本ずつ立て、
 * 4点で8本の方程式 = 8x8 連立一次方程式をガウス消去で解く。
 */
export function computeHomography(srcQuad: Quad, dstW: number, dstH: number): number[] {
  const dstPoints: [number, number][] = [
    [0, 0],
    [dstW, 0],
    [dstW, dstH],
    [0, dstH],
  ];

  // 8x8 の係数行列 A と右辺 b（増大行列として 8x9 にまとめる）
  // 各対応点 (x,y) -> (X,Y) について:
  //   h0*x + h1*y + h2 - h6*x*X - h7*y*X = X
  //   h3*x + h4*y + h5 - h6*x*Y - h7*y*Y = Y
  const A: number[][] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = dstPoints[i];
    const [X, Y] = srcQuad[i];
    A.push([x, y, 1, 0, 0, 0, -x * X, -y * X, X]);
    A.push([0, 0, 0, x, y, 1, -x * Y, -y * Y, Y]);
  }

  const h = solveLinearSystem(A);
  // h0..h7 が解。h8(=h22) は 1 に固定
  return [h[0], h[1], h[2], h[3], h[4], h[5], h[6], h[7], 1];
}

/**
 * 8x9 の増大行列（係数8列+右辺1列）をガウス消去（部分ピボット選択付き）で解き、
 * 長さ8の解ベクトルを返す。
 */
function solveLinearSystem(augmented: number[][]): number[] {
  const n = augmented.length; // 8
  const m = augmented.map((row) => row.slice()); // コピーして破壊的に変形

  for (let col = 0; col < n; col++) {
    // 部分ピボット選択: 絶対値最大の行を選んで数値安定性を確保
    let pivotRow = col;
    let maxAbs = Math.abs(m[col][col]);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(m[r][col]);
      if (v > maxAbs) {
        maxAbs = v;
        pivotRow = r;
      }
    }
    if (pivotRow !== col) {
      const tmp = m[col];
      m[col] = m[pivotRow];
      m[pivotRow] = tmp;
    }

    const pivot = m[col][col];
    if (Math.abs(pivot) < 1e-12) {
      // 特異（縮退）な場合は単位的なフォールバックとして0を入れる
      continue;
    }

    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = m[r][col] / pivot;
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) {
        m[r][c] -= factor * m[col][c];
      }
    }
  }

  const result = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const pivot = m[i][i];
    result[i] = Math.abs(pivot) < 1e-12 ? 0 : m[i][n] / pivot;
  }
  return result;
}

/** 3x3行列（row-major長さ9） と (x,y) の積を計算し、正規化前の (x', y', w) を返す */
function applyHomography(h: number[], x: number, y: number): [number, number, number] {
  const X = h[0] * x + h[1] * y + h[2];
  const Y = h[3] * x + h[4] * y + h[5];
  const W = h[6] * x + h[7] * y + h[8];
  return [X, Y, W];
}

/**
 * src画像上の四角形 quad（左上,右上,右下,左下）を w×h の矩形に台形補正した ImageData を返す。
 * 出力ピクセル (X,Y) ごとに H を適用して src 上の対応座標 (x,y) を求める逆方向マッピング方式。
 * src の範囲外を参照する場合は白（不透明）で埋める。
 */
export function rectifyQuad(src: ImageData, quad: Quad, w: number, h: number): ImageData {
  const width = Math.max(1, Math.round(w));
  const height = Math.max(1, Math.round(h));
  const dst = new ImageData(width, height);

  // 出力矩形(0,0)-(w,h) -> srcQuad へのホモグラフィ
  const H = computeHomography(quad, width, height);

  const srcW = src.width;
  const srcH = src.height;
  const srcData = src.data;
  const dstData = dst.data;

  for (let dy = 0; dy < height; dy++) {
    for (let dx = 0; dx < width; dx++) {
      // 出力ピクセル中心(dx+0.5, dy+0.5)をsrc座標へ写す
      const [X, Y, W] = applyHomography(H, dx + 0.5, dy + 0.5);
      const di = (dy * width + dx) * 4;

      if (Math.abs(W) < 1e-12) {
        writeWhite(dstData, di);
        continue;
      }

      const sx = X / W;
      const sy = Y / W;

      if (sx < 0 || sy < 0 || sx > srcW || sy > srcH) {
        writeWhite(dstData, di);
        continue;
      }

      sampleBilinear(srcData, srcW, srcH, sx, sy, dstData, di);
    }
  }

  return dst;
}

/** 出力バッファの指定オフセットに不透明な白を書き込む */
function writeWhite(data: Uint8ClampedArray, offset: number): void {
  data[offset] = 255;
  data[offset + 1] = 255;
  data[offset + 2] = 255;
  data[offset + 3] = 255;
}

/**
 * src画像上の連続座標 (sx, sy) をバイリニア補間でサンプリングし、dstの指定位置に書き込む。
 * src座標系はピクセル中心が (i+0.5, j+0.5) であるとみなす。範囲外側のサンプルは白として扱う。
 */
function sampleBilinear(
  srcData: Uint8ClampedArray,
  srcW: number,
  srcH: number,
  sx: number,
  sy: number,
  dstData: Uint8ClampedArray,
  dstOffset: number,
): void {
  // ピクセル中心基準に変換して4近傍の整数座標を求める
  const fx = sx - 0.5;
  const fy = sy - 0.5;
  const x0 = Math.floor(fx);
  const y0 = Math.floor(fy);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const tx = fx - x0;
  const ty = fy - y0;

  const c00 = getPixel(srcData, srcW, srcH, x0, y0);
  const c10 = getPixel(srcData, srcW, srcH, x1, y0);
  const c01 = getPixel(srcData, srcW, srcH, x0, y1);
  const c11 = getPixel(srcData, srcW, srcH, x1, y1);

  for (let ch = 0; ch < 4; ch++) {
    const top = c00[ch] * (1 - tx) + c10[ch] * tx;
    const bottom = c01[ch] * (1 - tx) + c11[ch] * tx;
    dstData[dstOffset + ch] = Math.round(top * (1 - ty) + bottom * ty);
  }
}

/** src画像の(x,y)ピクセルを取得。範囲外は白(255,255,255,255)を返す */
function getPixel(data: Uint8ClampedArray, w: number, h: number, x: number, y: number): Uint8ClampedArray {
  if (x < 0 || y < 0 || x >= w || y >= h) {
    return WHITE_PIXEL;
  }
  const i = (y * w + x) * 4;
  return data.subarray(i, i + 4);
}

const WHITE_PIXEL = new Uint8ClampedArray([255, 255, 255, 255]);
