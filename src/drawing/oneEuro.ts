// One Euro Filter 自前実装（入力点列の平滑化用）
// 参考: Casiez, Roussel, Vogel (2012) "1€ Filter"
// 高速移動時はカットオフを上げて追従性を高め、低速時はノイズを抑える適応的ローパス。

/** 単純なローパスフィルタ（指数移動平均） */
class LowPassFilter {
  private hasValue = false;
  private storedValue = 0;

  /**
   * @param alpha 0–1。1に近いほど入力に追従し、0に近いほど平滑化が強い
   */
  filter(value: number, alpha: number): number {
    if (!this.hasValue) {
      this.storedValue = value;
      this.hasValue = true;
    } else {
      this.storedValue = alpha * value + (1 - alpha) * this.storedValue;
    }
    return this.storedValue;
  }

  lastValue(): number {
    return this.storedValue;
  }

  reset(): void {
    this.hasValue = false;
    this.storedValue = 0;
  }
}

const computeAlpha = (cutoff: number, dt: number): number => {
  // dt<=0 のときは平滑化を無効化（前回値をそのまま使う）
  if (dt <= 0) return 1;
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
};

/** One Euro Filter: 1次元の値（座標やサイズなど）を時刻付きで平滑化する */
export class OneEuroFilter {
  private minCutoff: number;
  private beta: number;
  private dCutoff: number;

  private xFilter = new LowPassFilter();
  private dxFilter = new LowPassFilter();
  private lastTimestampMs: number | null = null;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
  }

  /** カットオフパラメータをUIから動的に変更する */
  setParameters(minCutoff: number, beta: number, dCutoff?: number): void {
    this.minCutoff = minCutoff;
    this.beta = beta;
    if (dCutoff !== undefined) this.dCutoff = dCutoff;
  }

  /**
   * @param value 入力値
   * @param timestampMs 入力のタイムスタンプ（ms）
   * @returns 平滑化された値
   */
  filter(value: number, timestampMs: number): number {
    let dt = 0;
    if (this.lastTimestampMs !== null) {
      dt = (timestampMs - this.lastTimestampMs) / 1000;
    }
    this.lastTimestampMs = timestampMs;

    // 前回値からの変化速度を推定し、その大きさでカットオフを動的に調整
    const prevX = this.xFilter.lastValue();
    const dx = dt > 0 ? (value - prevX) / dt : 0;
    const edx = this.dxFilter.filter(dx, computeAlpha(this.dCutoff, dt));

    const cutoff = this.minCutoff + this.beta * Math.abs(edx);
    return this.xFilter.filter(value, computeAlpha(cutoff, dt));
  }

  /** 内部状態をリセット（新規ストローク開始時に呼ぶ） */
  reset(): void {
    this.xFilter.reset();
    this.dxFilter.reset();
    this.lastTimestampMs = null;
  }
}

/** 2次元座標(x, y)用ヘルパ。x/yを独立したOneEuroFilterで平滑化する */
export class OneEuroFilter2D {
  private filterX: OneEuroFilter;
  private filterY: OneEuroFilter;

  constructor(minCutoff = 1.0, beta = 0.007, dCutoff = 1.0) {
    this.filterX = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.filterY = new OneEuroFilter(minCutoff, beta, dCutoff);
  }

  setParameters(minCutoff: number, beta: number, dCutoff?: number): void {
    this.filterX.setParameters(minCutoff, beta, dCutoff);
    this.filterY.setParameters(minCutoff, beta, dCutoff);
  }

  filter(x: number, y: number, timestampMs: number): { x: number; y: number } {
    return {
      x: this.filterX.filter(x, timestampMs),
      y: this.filterY.filter(y, timestampMs),
    };
  }

  reset(): void {
    this.filterX.reset();
    this.filterY.reset();
  }
}
