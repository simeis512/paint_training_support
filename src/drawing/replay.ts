// タイムラプス再生: ストローク列を任意速度で再生する
import type { LayerId, Stroke, StrokePoint } from '../store/types';
import { DEFAULT_BRUSH, renderFullStroke } from './brush';

export type ReplayItem = { layer: LayerId; stroke: Stroke };
export type ReplayOptions = { width: number; height: number };

/** ストローク間ギャップの上限（待ち時間が長すぎる場合に詰める） */
const MAX_GAP_MS = 400;

/** タイムライン上での1ストロークの再生区間 */
type TimelineEntry = {
  item: ReplayItem;
  /** タイムライン全体での開始時刻(ms) */
  startMs: number;
  /** タイムライン全体での終了時刻(ms) */
  endMs: number;
  /** ストローク内のt値の最小値（オフセット補正用） */
  tOffset: number;
};

export class ReplayPlayer {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private width: number;
  private height: number;
  private dpr: number;

  private timeline: TimelineEntry[] = [];
  private totalDuration = 0;

  private elapsedMs = 0;
  private speed = 1;
  private playing = false;
  private rafId: number | null = null;
  private lastFrameTime: number | null = null;
  private destroyed = false;

  onProgress?: (progress: number) => void;
  onEnd?: () => void;

  constructor(canvas: HTMLCanvasElement, items: ReplayItem[], opts: ReplayOptions) {
    this.canvas = canvas;
    this.width = opts.width;
    this.height = opts.height;
    this.dpr = window.devicePixelRatio || 1;

    this.canvas.width = Math.round(this.width * this.dpr);
    this.canvas.height = Math.round(this.height * this.dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;

    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('2D context を取得できませんでした');
    this.ctx = ctx;
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this.buildTimeline(items);
    this.render();
  }

  /** ストロークごとの再生区間を構築する。ギャップは上限クランプして詰める */
  private buildTimeline(items: ReplayItem[]): void {
    let cursor = 0;
    for (const item of items) {
      const points = item.stroke.points;
      if (points.length === 0) continue;

      const tOffset = points[0].t;
      const tLast = points[points.length - 1].t;
      const strokeDuration = Math.max(0, tLast - tOffset);

      const startMs = cursor;
      const endMs = startMs + strokeDuration;
      this.timeline.push({ item, startMs, endMs, tOffset });

      cursor = endMs + MAX_GAP_MS;
    }

    // 末尾の余分なギャップを除去
    if (this.timeline.length > 0) {
      this.totalDuration = this.timeline[this.timeline.length - 1].endMs;
    } else {
      this.totalDuration = 0;
    }
  }

  /** 合成総時間ms（ストローク間ギャップは上限クランプして詰める） */
  get duration(): number {
    return this.totalDuration;
  }

  play(): void {
    if (this.playing || this.destroyed) return;
    if (this.totalDuration === 0) return;
    if (this.elapsedMs >= this.totalDuration) {
      this.elapsedMs = 0;
    }
    this.playing = true;
    this.lastFrameTime = null;
    this.rafId = requestAnimationFrame(this.tick);
  }

  pause(): void {
    this.playing = false;
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    this.lastFrameTime = null;
  }

  stop(): void {
    this.pause();
    this.elapsedMs = 0;
    this.render();
    this.onProgress?.(0);
  }

  /** 再生速度の倍率（0.5, 1, 2, 4, 8 など任意） */
  setSpeed(multiplier: number): void {
    this.speed = multiplier > 0 ? multiplier : 1;
  }

  /** 0–1 の進行率で再生位置をシークする */
  seek(progress: number): void {
    const clamped = Math.min(1, Math.max(0, progress));
    this.elapsedMs = clamped * this.totalDuration;
    this.render();
    this.onProgress?.(clamped);
  }

  private tick = (now: number): void => {
    if (!this.playing || this.destroyed) return;

    if (this.lastFrameTime === null) {
      this.lastFrameTime = now;
    }
    const dt = now - this.lastFrameTime;
    this.lastFrameTime = now;

    this.elapsedMs += dt * this.speed;
    if (this.elapsedMs >= this.totalDuration) {
      this.elapsedMs = this.totalDuration;
      this.render();
      this.onProgress?.(1);
      this.playing = false;
      this.rafId = null;
      this.onEnd?.();
      return;
    }

    this.render();
    this.onProgress?.(this.totalDuration > 0 ? this.elapsedMs / this.totalDuration : 0);
    this.rafId = requestAnimationFrame(this.tick);
  };

  /** 現在の elapsedMs までの状態をキャンバスに描画する */
  private render(): void {
    this.ctx.save();
    this.ctx.setTransform(1, 0, 0, 1, 0, 0);
    this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.ctx.restore();

    for (const entry of this.timeline) {
      if (this.elapsedMs <= entry.startMs) continue;

      const stroke = entry.item.stroke;
      let points: StrokePoint[];

      if (this.elapsedMs >= entry.endMs) {
        points = stroke.points;
      } else {
        const localT = entry.tOffset + (this.elapsedMs - entry.startMs);
        points = stroke.points.filter((pt) => pt.t <= localT);
        if (points.length === 0) continue;
      }

      // brushIdは未知でもDEFAULT_BRUSHベースで色だけ反映する
      renderFullStroke(this.ctx, points, DEFAULT_BRUSH, stroke.color, this.dpr);
    }
  }

  destroy(): void {
    this.pause();
    this.destroyed = true;
  }
}
