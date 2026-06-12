// 筆圧 → 線幅/不透明度のレスポンスカーブ評価 と ブラシスタンプ生成
import type { BrushConfig, PressureCurve, StrokePoint } from '../store/types';

/**
 * 3次ベジェ（端点 (0,0)-(1,1) 固定）を CSS cubic-bezier と同等に評価する。
 * x=p に対応する t をニュートン法（収束しない場合は二分法にフォールバック）で求め、
 * その t における y を返す。
 */
export const evalPressureCurve = (curve: PressureCurve, p: number): number => {
  const x = Math.min(1, Math.max(0, p));
  const [x1, y1] = curve.cp1;
  const [x2, y2] = curve.cp2;

  // 端点近傍は早期return（数値誤差・反復回避）
  if (x <= 0) return 0;
  if (x >= 1) return 1;

  // ベジェ係数: B(t) = 3(1-t)^2 t * p1 + 3(1-t) t^2 * p2 + t^3  (端点0,1は寄与なし)
  const bezierX = (t: number): number => {
    const mt = 1 - t;
    return 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t;
  };
  const bezierXDerivative = (t: number): number => {
    const mt = 1 - t;
    return 3 * mt * mt * x1 + 6 * mt * t * (x2 - x1) + 3 * t * t * (1 - x2);
  };
  const bezierY = (t: number): number => {
    const mt = 1 - t;
    return 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t;
  };

  // ニュートン法（初期値はxそのもの。導関数がほぼ0なら二分法に切替）
  let t = x;
  for (let i = 0; i < 8; i++) {
    const dx = bezierX(t) - x;
    if (Math.abs(dx) < 1e-6) break;
    const d = bezierXDerivative(t);
    if (Math.abs(d) < 1e-6) break;
    t -= dx / d;
    t = Math.min(1, Math.max(0, t));
  }

  // ニュートン法が十分収束しなかった場合は二分法で補正
  if (Math.abs(bezierX(t) - x) > 1e-4) {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 32; i++) {
      t = (lo + hi) / 2;
      if (bezierX(t) < x) lo = t;
      else hi = t;
    }
  }

  return Math.min(1, Math.max(0, bezierY(t)));
};

/** デフォルトブラシ: リニアに近いカーブ・ソフト円スタンプ */
export const DEFAULT_BRUSH: BrushConfig = {
  id: 'default',
  name: 'デフォルト',
  size: 12,
  opacity: 1,
  sizeCurve: { cp1: [0.25, 0.25], cp2: [0.75, 0.75] },
  opacityCurve: { cp1: [0.25, 0.25], cp2: [0.75, 0.75] },
  spacing: 0.15,
  hardness: 0.7,
};

// --- ブラシスタンプ（オフスクリーンcanvasキャッシュ） ---

/** スタンプキャッシュのキー（直径・硬さ・色を量子化して結合） */
const stampKey = (diameter: number, hardness: number, color: string): string => {
  const d = Math.max(1, Math.round(diameter));
  const h = Math.round(hardness * 100);
  return `${d}_${h}_${color}`;
};

const stampCache = new Map<string, OffscreenCanvas | HTMLCanvasElement>();

/**
 * ブラシ・色からソフト円スタンプ画像を生成しキャッシュする。
 * radial gradient で hardness を反映（hardness=1ほど中心まで不透明で縁が硬い）。
 * @param diameter スタンプ直径（px、デバイス解像度基準）
 */
export const brushStamp = (
  brush: BrushConfig,
  color: string,
  diameter: number,
): OffscreenCanvas | HTMLCanvasElement => {
  const key = stampKey(diameter, brush.hardness, color);
  const cached = stampCache.get(key);
  if (cached) return cached;

  const size = Math.max(1, Math.ceil(diameter));
  const supportsOffscreen = typeof OffscreenCanvas !== 'undefined';
  let canvas: OffscreenCanvas | HTMLCanvasElement;
  if (supportsOffscreen) {
    canvas = new OffscreenCanvas(size, size);
  } else {
    const el = document.createElement('canvas');
    el.width = size;
    el.height = size;
    canvas = el;
  }

  const ctx = canvas.getContext('2d') as
    | CanvasRenderingContext2D
    | OffscreenCanvasRenderingContext2D
    | null;
  if (!ctx) return canvas;

  const radius = size / 2;
  // hardness=0: 中心から外側まで広くフェード / hardness=1: 縁直前までほぼ不透明
  const innerStop = Math.min(0.99, Math.max(0, brush.hardness));
  const gradient = ctx.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, color);
  gradient.addColorStop(innerStop, color);
  gradient.addColorStop(1, hexToTransparent(color));

  ctx.clearRect(0, 0, size, size);
  ctx.fillStyle = gradient;
  ctx.beginPath();
  ctx.arc(radius, radius, radius, 0, Math.PI * 2);
  ctx.fill();

  stampCache.set(key, canvas);
  return canvas;
};

/** スタンプキャッシュを全消去（色やブラシ設定を大きく変えた際の開放用） */
export const clearStampCache = (): void => {
  stampCache.clear();
};

/** カラー文字列をアルファ0版に変換（グラデーション終端用） */
const hexToTransparent = (color: string): string => {
  // #rrggbb / #rgb / rgb()/rgba() / 名前付き色などに対応するため、
  // canvasに一度描いてrgbを取り出すのが確実だが重いので簡易パースで対応。
  if (color.startsWith('#')) {
    let hex = color.slice(1);
    if (hex.length === 3) {
      hex = hex
        .split('')
        .map((c) => c + c)
        .join('');
    }
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    return `rgba(${r}, ${g}, ${b}, 0)`;
  }
  if (color.startsWith('rgb')) {
    const nums = color.match(/[\d.]+/g);
    if (nums && nums.length >= 3) {
      return `rgba(${nums[0]}, ${nums[1]}, ${nums[2]}, 0)`;
    }
  }
  // フォールバック: 黒透明
  return 'rgba(0, 0, 0, 0)';
};

// --- ストローク点列 → スタンプ列への変換（engine/replay 共有） ---

/** 1つのスタンプ描画指示 */
export type StampInstruction = {
  x: number;
  y: number;
  /** スタンプ直径（CSS px） */
  diameter: number;
  /** 不透明度 0–1 */
  alpha: number;
};

/** スタンプ間隔計算用の継続状態。ストロークごとに新規生成する */
export type StampWalkState = {
  started: boolean;
  /** 直近のスタンプ位置 */
  lastX: number;
  lastY: number;
  /** 次のスタンプまでの残り距離（spacingからの繰り越し） */
  distanceToNext: number;
};

export const createStampWalkState = (): StampWalkState => ({
  started: false,
  lastX: 0,
  lastY: 0,
  distanceToNext: 0,
});

/**
 * 新たに到着した点列（追加分）を受け取り、spacing間隔でスタンプ位置を算出する。
 * 筆圧は線幅・不透明度の両カーブに適用する。
 * @param points 追加された点（1点以上）
 * @param emit スタンプを1つ生成するたびに呼ばれるコールバック
 */
export const walkStampsForPoints = (
  points: StrokePoint[],
  brush: BrushConfig,
  state: StampWalkState,
  emit: (stamp: StampInstruction) => void,
): void => {
  for (const point of points) {
    const diameter = Math.max(0.5, brush.size * evalPressureCurve(brush.sizeCurve, point.p));
    const alpha = Math.max(0, Math.min(1, brush.opacity * evalPressureCurve(brush.opacityCurve, point.p)));
    const step = Math.max(0.5, brush.spacing * diameter);

    if (!state.started) {
      // ストローク最初の点は必ず1スタンプ打つ
      emit({ x: point.x, y: point.y, diameter, alpha });
      state.started = true;
      state.lastX = point.x;
      state.lastY = point.y;
      state.distanceToNext = step;
      continue;
    }

    let dx = point.x - state.lastX;
    let dy = point.y - state.lastY;
    let segmentLength = Math.hypot(dx, dy);

    while (segmentLength >= state.distanceToNext) {
      const ratio = state.distanceToNext / segmentLength;
      const stampX = state.lastX + dx * ratio;
      const stampY = state.lastY + dy * ratio;
      emit({ x: stampX, y: stampY, diameter, alpha });

      // 残りセグメントを更新
      state.lastX = stampX;
      state.lastY = stampY;
      dx = point.x - state.lastX;
      dy = point.y - state.lastY;
      segmentLength = Math.hypot(dx, dy);
      state.distanceToNext = step;
    }

    state.distanceToNext -= segmentLength;
    state.lastX = point.x;
    state.lastY = point.y;
  }
};

/**
 * キャンバスコンテキストにスタンプを1つ描画する。
 * ctx には事前に devicePixelRatio に応じた scale が適用されている前提（CSS px座標で描く）。
 */
export const drawStamp = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  brush: BrushConfig,
  color: string,
  stamp: StampInstruction,
  dpr: number,
): void => {
  // スタンプ画像は実解像度（dpr倍）で生成し、描画先はCSS px寸法で指定する
  const sourceDiameter = stamp.diameter * dpr;
  const image = brushStamp(brush, color, sourceDiameter);
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = stamp.alpha;
  ctx.drawImage(
    image as CanvasImageSource,
    stamp.x - stamp.diameter / 2,
    stamp.y - stamp.diameter / 2,
    stamp.diameter,
    stamp.diameter,
  );
  ctx.globalAlpha = prevAlpha;
};

/**
 * ストローク全体をコンテキストに描画する（redraw・replay 用）。
 * 新規の StampWalkState を生成して最初から最後まで再生する。
 */
export const renderFullStroke = (
  ctx: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D,
  points: StrokePoint[],
  brush: BrushConfig,
  color: string,
  dpr: number,
): void => {
  const state = createStampWalkState();
  walkStampsForPoints(points, brush, state, (stamp) => drawStamp(ctx, brush, color, stamp, dpr));
};
