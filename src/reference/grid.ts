// グリッドオーバーレイ描画ユーティリティ（グリッド模写: 参照画像とキャンバスに同期表示する）

/** 分割数 n（縦横同数、2〜8想定） */
export type GridSpec = { n: number };

/**
 * w×h 領域に n×n のグリッド線を描く（外周を含むメジャー線のみ）。
 * 既定は半透明シアンの細線。ctx の状態（strokeStyle等）は呼び出し前後で変更したまま戻さないため、
 * 必要に応じて呼び出し側で save/restore すること。
 */
export function drawGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
  opts?: { color?: string; lineWidth?: number },
): void {
  const cols = Math.max(1, Math.round(n));
  const color = opts?.color ?? 'rgba(0, 200, 255, 0.6)';
  const lineWidth = opts?.lineWidth ?? 1;

  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lineWidth;
  ctx.beginPath();

  // 縦線（外周含む n+1 本）
  for (let i = 0; i <= cols; i++) {
    const x = (w * i) / cols;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, h);
  }
  // 横線（外周含む n+1 本）
  for (let i = 0; i <= cols; i++) {
    const y = (h * i) / cols;
    ctx.moveTo(0, y);
    ctx.lineTo(w, y);
  }

  ctx.stroke();
  ctx.restore();
}

/**
 * 各セルの左上にラベル（A1, A2, ... / B1, B2, ... のように行=英字, 列=数字）を描く。
 * 行は A から、列は 1 から始まる。
 */
export function drawGridLabels(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  n: number,
  opts?: { color?: string; font?: string },
): void {
  const cols = Math.max(1, Math.round(n));
  const color = opts?.color ?? 'rgba(0, 200, 255, 0.8)';
  const font = opts?.font ?? `${Math.max(10, Math.min(w, h) / (cols * 4))}px sans-serif`;

  ctx.save();
  ctx.fillStyle = color;
  ctx.font = font;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';

  const padding = Math.max(2, Math.min(w, h) / (cols * 20));

  for (let row = 0; row < cols; row++) {
    for (let col = 0; col < cols; col++) {
      const rect = cellRect(w, h, cols, row, col);
      const label = `${rowLabel(row)}${col + 1}`;
      ctx.fillText(label, rect.x + padding, rect.y + padding);
    }
  }

  ctx.restore();
}

/** 行インデックス(0始まり)をアルファベットラベルに変換（0→A, 1→B, ..., 25→Z, 26→AA, ...） */
function rowLabel(row: number): string {
  let n = row;
  let label = '';
  do {
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26) - 1;
  } while (n >= 0);
  return label;
}

/** セル番号 (row, col)（0始まり）に対応するピクセル矩形を返す */
export function cellRect(w: number, h: number, n: number, row: number, col: number): { x: number; y: number; w: number; h: number } {
  const cols = Math.max(1, Math.round(n));
  const x0 = (w * col) / cols;
  const x1 = (w * (col + 1)) / cols;
  const y0 = (h * row) / cols;
  const y1 = (h * (row + 1)) / cols;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}
