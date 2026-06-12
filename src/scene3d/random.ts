// シード付き決定論的 PRNG。src/scene3d/ では Math.random を禁止し、すべてここ経由で乱数生成する。

/** mulberry32: 32bit シードから [0,1) を返す決定論的 PRNG を生成 */
export function createRng(seed: number): () => number {
  // シードを 32bit 符号なし整数に正規化（負値・小数も安定化）
  let a = seed >>> 0;
  return function (): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** [min, max) の実数 */
export function rangeFloat(rng: () => number, min: number, max: number): number {
  return min + (max - min) * rng();
}

/** [min, max]（両端含む）の整数 */
export function rangeInt(rng: () => number, min: number, max: number): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 配列から1要素を決定論的に選ぶ */
export function pick<T>(rng: () => number, items: readonly T[]): T {
  return items[Math.floor(rng() * items.length)];
}

/** rng() < p で true */
export function chance(rng: () => number, p: number): boolean {
  return rng() < p;
}
