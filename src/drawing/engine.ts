// 描画エンジン本体: レイヤー管理・入力処理・スタンプレンダリング・Undo/Redo
import type { BrushConfig, LayerId, Stroke, StrokePoint } from '../store/types';
import { OneEuroFilter, OneEuroFilter2D } from './oneEuro';
import {
  DEFAULT_BRUSH,
  createStampWalkState,
  drawStamp,
  renderFullStroke,
  walkStampsForPoints,
  type StampWalkState,
} from './brush';

export type EngineOptions = { width: number; height: number };

/** 内部で保持するストローク記録（再描画・undo/redo・出力用） */
type StrokeRecord = {
  stroke: Stroke;
  brush: BrushConfig;
  /** getStrokes() での全体描画順を保証するための連番 */
  seq: number;
};

/** Undo操作の履歴エントリ */
type HistoryEntry =
  | { type: 'stroke'; layer: LayerId }
  | { type: 'clear'; layer: LayerId; removed: StrokeRecord[] };

/** Redoに必要な情報 */
type RedoEntry =
  | { type: 'stroke'; layer: LayerId; record: StrokeRecord }
  | { type: 'clear'; layer: LayerId; count: number };

type LayerState = {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  visible: boolean;
  opacity: number;
  strokes: StrokeRecord[];
};

const LAYER_ORDER: LayerId[] = ['draft', 'sketch']; // draft=下絵(下), sketch=作画(上)

/** ポインタ速度から疑似筆圧を求める際の正規化用係数（px/ms） */
const PSEUDO_PRESSURE_SPEED_SCALE = 1.2;

export class DrawingEngine {
  private targetCanvas: HTMLCanvasElement;
  private targetCtx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private dpr: number;

  private layers: Map<LayerId, LayerState> = new Map();
  private activeLayer: LayerId = 'sketch';

  private previewCanvas: HTMLCanvasElement;
  private previewCtx: CanvasRenderingContext2D;

  private currentBrush: BrushConfig = DEFAULT_BRUSH;
  private currentColor = '#000000';

  private undoStack: HistoryEntry[] = [];
  private redoStack: RedoEntry[] = [];
  private seqCounter = 0;

  private smoothing: OneEuroFilter2D = new OneEuroFilter2D(1.0, 0.007, 1.0);
  /** mouse/touch 用の疑似筆圧を平滑化するための1次元フィルタ */
  private pseudoPressureFilter: OneEuroFilter = new OneEuroFilter(1.0, 0.007, 1.0);

  // 描画中ストロークの状態
  private isDrawing = false;
  private activePointerId: number | null = null;
  private currentPoints: StrokePoint[] = [];
  private strokeStartTime = 0;
  private lastSampleX = 0;
  private lastSampleY = 0;
  private lastSampleTime = 0;
  private stampState: StampWalkState = createStampWalkState();

  private dirty = true;
  private rafId: number | null = null;
  private destroyed = false;

  // attachInput/detachInput で使うイベントハンドラ参照
  private boundPointerDown: (e: PointerEvent) => void;
  private boundPointerMove: (e: PointerEvent) => void;
  private boundPointerUp: (e: PointerEvent) => void;
  private boundPointerCancel: (e: PointerEvent) => void;
  private attached = false;

  /** undo/redo可否やストローク数が変わったときのUI通知 */
  onChange?: () => void;

  constructor(targetCanvas: HTMLCanvasElement, opts: EngineOptions) {
    this.targetCanvas = targetCanvas;
    this.width = opts.width;
    this.height = opts.height;
    this.dpr = window.devicePixelRatio || 1;

    this.setupCanvasElement(this.targetCanvas);
    const ctx = this.targetCanvas.getContext('2d');
    if (!ctx) throw new Error('2D context を取得できませんでした');
    this.targetCtx = ctx;

    // レイヤー用オフスクリーンcanvasを生成（draft=下絵が下、sketch=作画が上）
    for (const layer of LAYER_ORDER) {
      const canvas = document.createElement('canvas');
      this.setupCanvasElement(canvas);
      const layerCtx = canvas.getContext('2d');
      if (!layerCtx) throw new Error('2D context を取得できませんでした');
      this.layers.set(layer, {
        canvas,
        ctx: layerCtx,
        visible: true,
        opacity: 1,
        strokes: [],
      });
    }

    // プレビュー用canvas（描画中ストロークの一時バッファ）
    this.previewCanvas = document.createElement('canvas');
    this.setupCanvasElement(this.previewCanvas);
    const previewCtx = this.previewCanvas.getContext('2d');
    if (!previewCtx) throw new Error('2D context を取得できませんでした');
    this.previewCtx = previewCtx;

    this.boundPointerDown = (e) => this.handlePointerDown(e);
    this.boundPointerMove = (e) => this.handlePointerMove(e);
    this.boundPointerUp = (e) => this.handlePointerUp(e);
    this.boundPointerCancel = (e) => this.handlePointerCancel(e);

    this.startRenderLoop();
  }

  /** canvas要素のCSSサイズと内部解像度（DPR倍）を設定し、CSS px基準で描けるようscaleする */
  private setupCanvasElement(canvas: HTMLCanvasElement): void {
    canvas.width = Math.round(this.width * this.dpr);
    canvas.height = Math.round(this.height * this.dpr);
    canvas.style.width = `${this.width}px`;
    canvas.style.height = `${this.height}px`;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
  }

  // --- 入力処理 ---

  /**
   * Pointer Events を targetCanvas に bind する。
   * pen は実筆圧、mouse/touch は速度ベースの疑似筆圧を使用する。
   */
  attachInput(): void {
    if (this.attached) return;
    this.targetCanvas.addEventListener('pointerdown', this.boundPointerDown);
    this.targetCanvas.addEventListener('pointermove', this.boundPointerMove);
    this.targetCanvas.addEventListener('pointerup', this.boundPointerUp);
    this.targetCanvas.addEventListener('pointercancel', this.boundPointerCancel);
    this.targetCanvas.addEventListener('pointerleave', this.boundPointerCancel);
    // ペン/タッチ操作時のスクロール・ジェスチャー抑制
    this.targetCanvas.style.touchAction = 'none';
    this.attached = true;
  }

  detachInput(): void {
    if (!this.attached) return;
    this.targetCanvas.removeEventListener('pointerdown', this.boundPointerDown);
    this.targetCanvas.removeEventListener('pointermove', this.boundPointerMove);
    this.targetCanvas.removeEventListener('pointerup', this.boundPointerUp);
    this.targetCanvas.removeEventListener('pointercancel', this.boundPointerCancel);
    this.targetCanvas.removeEventListener('pointerleave', this.boundPointerCancel);
    this.attached = false;
  }

  /** クライアント座標 → canvas内のCSS px座標へ変換 */
  private getCanvasPosition(e: PointerEvent | { clientX: number; clientY: number }): { x: number; y: number } {
    const rect = this.targetCanvas.getBoundingClientRect();
    const scaleX = rect.width > 0 ? this.width / rect.width : 1;
    const scaleY = rect.height > 0 ? this.height / rect.height : 1;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    };
  }

  /** pointerType==='pen' なら実筆圧、それ以外は速度ベースの疑似筆圧を返す */
  private resolvePressure(e: PointerEvent, x: number, y: number, timeMs: number): number {
    if (e.pointerType === 'pen') {
      // 一部デバイスは未接触/ホバー時に0を返すため最低値を保証
      return e.pressure > 0 ? e.pressure : 0.5;
    }

    // mouse/touch: 移動速度から疑似筆圧を算出（速いほど線が細くなるよう小さい値にする）
    const dt = Math.max(1, timeMs - this.lastSampleTime);
    const dist = Math.hypot(x - this.lastSampleX, y - this.lastSampleY);
    const speed = dist / dt; // px/ms

    // 速度0で1.0に近づき、速いほど0へ近づく
    const raw = 1 / (1 + speed / PSEUDO_PRESSURE_SPEED_SCALE);
    const clamped = Math.min(1, Math.max(0.05, raw));

    // 急変防止のため平滑化
    return this.pseudoPressureFilter.filter(clamped, timeMs);
  }

  private handlePointerDown(e: PointerEvent): void {
    if (this.isDrawing) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return; // 右クリック等は無視

    this.isDrawing = true;
    this.activePointerId = e.pointerId;
    this.targetCanvas.setPointerCapture?.(e.pointerId);

    this.smoothing.reset();
    this.pseudoPressureFilter.reset();
    this.stampState = createStampWalkState();
    this.currentPoints = [];

    this.strokeStartTime = performance.now();
    const pos = this.getCanvasPosition(e);
    this.lastSampleTime = this.strokeStartTime;
    this.lastSampleX = pos.x;
    this.lastSampleY = pos.y;

    this.previewCtx.clearRect(0, 0, this.width, this.height);

    this.addSample(e, pos.x, pos.y, this.strokeStartTime);
    e.preventDefault();
  }

  private handlePointerMove(e: PointerEvent): void {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;

    // getCoalescedEvents() で全サンプルを取得（未対応環境はイベント自身のみ）
    const events =
      typeof e.getCoalescedEvents === 'function' && e.getCoalescedEvents().length > 0
        ? e.getCoalescedEvents()
        : [e];

    const now = performance.now();
    const lastEvent = events[events.length - 1];
    // 各サンプルの相対時刻を、現在時刻を終点として timeStamp の差分から逆算する
    const baseTimeMs = now - (lastEvent.timeStamp - events[0].timeStamp);

    for (const ev of events) {
      const pos = this.getCanvasPosition(ev);
      const sampleTime = baseTimeMs + (ev.timeStamp - events[0].timeStamp);
      this.addSample(ev, pos.x, pos.y, sampleTime);
    }
    e.preventDefault();
  }

  private handlePointerUp(e: PointerEvent): void {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;
    this.finishStroke();
  }

  private handlePointerCancel(e: PointerEvent): void {
    if (!this.isDrawing || e.pointerId !== this.activePointerId) return;
    this.finishStroke();
  }

  /** 1サンプル分の点を取り込み、平滑化・疑似筆圧算出・プレビュー描画を行う */
  private addSample(e: PointerEvent, rawX: number, rawY: number, timeMs: number): void {
    const filtered = this.smoothing.filter(rawX, rawY, timeMs);
    const pressure = this.resolvePressure(e, rawX, rawY, timeMs);

    const point: StrokePoint = {
      x: filtered.x,
      y: filtered.y,
      p: pressure,
      t: Math.max(0, timeMs - this.strokeStartTime),
    };
    this.currentPoints.push(point);

    walkStampsForPoints([point], this.currentBrush, this.stampState, (stamp) => {
      drawStamp(this.previewCtx, this.currentBrush, this.currentColor, stamp, this.dpr);
    });

    this.lastSampleTime = timeMs;
    this.lastSampleX = rawX;
    this.lastSampleY = rawY;
    this.dirty = true;
  }

  /** 描画中ストロークを確定し、レイヤーcanvasへ統合する */
  private finishStroke(): void {
    this.isDrawing = false;
    this.activePointerId = null;

    if (this.currentPoints.length > 0) {
      const layerState = this.layers.get(this.activeLayer);
      if (layerState) {
        // プレビューを確定としてレイヤーcanvasへ統合（device px単位でそのままコピー）
        layerState.ctx.save();
        layerState.ctx.setTransform(1, 0, 0, 1, 0, 0);
        layerState.ctx.drawImage(this.previewCanvas, 0, 0);
        layerState.ctx.restore();

        const stroke: Stroke = {
          points: this.currentPoints,
          brushId: this.currentBrush.id,
          color: this.currentColor,
        };
        const record: StrokeRecord = {
          stroke,
          brush: this.currentBrush,
          seq: this.seqCounter++,
        };
        layerState.strokes.push(record);
        this.undoStack.push({ type: 'stroke', layer: this.activeLayer });
        this.redoStack = [];
      }
    }

    this.previewCtx.clearRect(0, 0, this.width, this.height);
    this.currentPoints = [];
    this.dirty = true;
    this.notifyChange();
  }

  // --- ブラシ・色・レイヤー設定 ---

  setBrush(brush: BrushConfig): void {
    this.currentBrush = brush;
  }

  setColor(color: string): void {
    this.currentColor = color;
  }

  setActiveLayer(layer: LayerId): void {
    this.activeLayer = layer;
  }

  getActiveLayer(): LayerId {
    return this.activeLayer;
  }

  setLayerVisible(layer: LayerId, visible: boolean): void {
    const state = this.layers.get(layer);
    if (!state) return;
    state.visible = visible;
    this.dirty = true;
  }

  setLayerOpacity(layer: LayerId, opacity: number): void {
    const state = this.layers.get(layer);
    if (!state) return;
    state.opacity = Math.min(1, Math.max(0, opacity));
    this.dirty = true;
  }

  /** One Euro Filter パラメータの動的調整（UI用） */
  setSmoothing(minCutoff: number, beta: number): void {
    this.smoothing.setParameters(minCutoff, beta);
  }

  // --- Undo/Redo ---
  // ストローク単位（クリアも1操作）。レイヤーcanvasはストローク列からの再描画で復元する。

  undo(): void {
    const entry = this.undoStack.pop();
    if (!entry) return;

    const layerState = this.layers.get(entry.layer);
    if (!layerState) return;

    if (entry.type === 'stroke') {
      const record = layerState.strokes.pop();
      if (record) {
        this.redoStack.push({ type: 'stroke', layer: entry.layer, record });
        this.redrawLayer(entry.layer);
      }
    } else {
      // clear の取り消し: 削除されたストロークを末尾に復元
      layerState.strokes.push(...entry.removed);
      this.redoStack.push({ type: 'clear', layer: entry.layer, count: entry.removed.length });
      this.redrawLayer(entry.layer);
    }

    this.dirty = true;
    this.notifyChange();
  }

  redo(): void {
    const entry = this.redoStack.pop();
    if (!entry) return;

    const layerState = this.layers.get(entry.layer);
    if (!layerState) return;

    if (entry.type === 'stroke') {
      layerState.strokes.push(entry.record);
      this.undoStack.push({ type: 'stroke', layer: entry.layer });
      this.redrawLayer(entry.layer);
    } else {
      const removed = layerState.strokes.splice(-entry.count, entry.count);
      this.undoStack.push({ type: 'clear', layer: entry.layer, removed });
      this.redrawLayer(entry.layer);
    }

    this.dirty = true;
    this.notifyChange();
  }

  canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  clearLayer(layer: LayerId): void {
    const state = this.layers.get(layer);
    if (!state || state.strokes.length === 0) return;

    const removed = state.strokes;
    state.strokes = [];
    this.undoStack.push({ type: 'clear', layer, removed });
    this.redoStack = [];
    this.redrawLayer(layer);
    this.dirty = true;
    this.notifyChange();
  }

  /** レイヤーcanvasをクリアし、現在のストローク列から再描画する（ビットマップ履歴を持たない） */
  private redrawLayer(layer: LayerId): void {
    const state = this.layers.get(layer);
    if (!state) return;

    state.ctx.save();
    state.ctx.setTransform(1, 0, 0, 1, 0, 0);
    state.ctx.clearRect(0, 0, state.canvas.width, state.canvas.height);
    state.ctx.restore();

    for (const record of state.strokes) {
      renderFullStroke(state.ctx, record.stroke.points, record.brush, record.stroke.color, this.dpr);
    }
  }

  /** 全レイヤーの全ストローク（描画順）。リプレイ・保存用 */
  getStrokes(): { layer: LayerId; stroke: Stroke }[] {
    const all: { layer: LayerId; stroke: Stroke; seq: number }[] = [];
    for (const layer of LAYER_ORDER) {
      const state = this.layers.get(layer);
      if (!state) continue;
      for (const record of state.strokes) {
        all.push({ layer, stroke: record.stroke, seq: record.seq });
      }
    }
    all.sort((a, b) => a.seq - b.seq);
    return all.map(({ layer, stroke }) => ({ layer, stroke }));
  }

  /** サムネイル等のためのコンポジット画像 */
  async exportImage(maxSize?: number): Promise<Blob> {
    this.compositeToTarget();

    let sourceCanvas: HTMLCanvasElement = this.targetCanvas;
    if (maxSize && maxSize > 0) {
      const longSide = Math.max(this.targetCanvas.width, this.targetCanvas.height);
      if (longSide > maxSize) {
        const scale = maxSize / longSide;
        const out = document.createElement('canvas');
        out.width = Math.max(1, Math.round(this.targetCanvas.width * scale));
        out.height = Math.max(1, Math.round(this.targetCanvas.height * scale));
        const outCtx = out.getContext('2d');
        if (outCtx) {
          outCtx.drawImage(this.targetCanvas, 0, 0, out.width, out.height);
          sourceCanvas = out;
        }
      }
    }

    return new Promise<Blob>((resolve, reject) => {
      sourceCanvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('画像の書き出しに失敗しました'));
      }, 'image/png');
    });
  }

  // --- 合成・描画ループ ---

  private startRenderLoop(): void {
    const loop = () => {
      if (this.destroyed) return;
      if (this.dirty) {
        this.compositeToTarget();
        this.dirty = false;
      }
      this.rafId = requestAnimationFrame(loop);
    };
    this.rafId = requestAnimationFrame(loop);
  }

  /** レイヤー（+ 描画中プレビュー）を targetCanvas に合成する */
  private compositeToTarget(): void {
    const ctx = this.targetCtx;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.targetCanvas.width, this.targetCanvas.height);

    for (const layer of LAYER_ORDER) {
      const state = this.layers.get(layer);
      if (!state || !state.visible) continue;
      ctx.globalAlpha = state.opacity;
      ctx.drawImage(state.canvas, 0, 0);
      if (this.isDrawing && layer === this.activeLayer) {
        ctx.drawImage(this.previewCanvas, 0, 0);
      }
    }
    ctx.globalAlpha = 1;
    ctx.restore();
  }

  private notifyChange(): void {
    this.onChange?.();
  }

  destroy(): void {
    this.detachInput();
    this.destroyed = true;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
  }
}
