// 正解データ書き出し。固定ビューでエッジマップ・線形化深度を取得する。
import type { SceneSpec } from './generator.ts';
import { OutlineRenderer } from './outline.ts';

export type GroundTruth = {
  /** 評価用エッジマップ（黒=線）。RGBA。 */
  edgeMap: { data: Uint8ClampedArray; width: number; height: number };
  /** 線形化深度 0–1（near=0, far=1, 背景=1）。1ch。 */
  depth: { data: Float32Array; width: number; height: number };
  spec: SceneSpec;
};

/**
 * 固定ビュー（呼び出し側で camera を spec に合わせ済みであること）で正解データを取得。
 * renderer/scene/camera は OutlineRenderer 構築時のものと一致している前提。
 */
export function captureGroundTruth(spec: SceneSpec, outline: OutlineRenderer): GroundTruth {
  // エッジマップ（黒=線）と線形化深度を同一ビューから読み出す
  const edgeMap = outline.renderToPixels();
  const depth = outline.readDepthPixels();
  return { edgeMap, depth, spec };
}
