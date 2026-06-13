// 画面間で共通する画像変換ユーティリティ（app層）
import { fileToImageData } from '../reference/capture';

/**
 * 描画エクスポート（透明背景PNG）をアルファ基準で「白地に黒インク」へ正規化する。
 * ストロークの色に依らずエッジ評価できるようにするための変換
 * （白系ブラシでも評価時に線が消えない）。
 */
export const drawingToInkImageData = async (blob: Blob, maxSize?: number): Promise<ImageData> => {
  const img = await fileToImageData(blob, maxSize);
  const d = img.data;
  for (let i = 0; i < d.length; i += 4) {
    const ink = 255 - d[i + 3]; // 不透明度→黒インク、透明部は白
    d[i] = ink;
    d[i + 1] = ink;
    d[i + 2] = ink;
    d[i + 3] = 255;
  }
  return img;
};

/** ImageData をオフスクリーンcanvasに描画する（EvaluationView へのサムネイル渡し等に使用） */
export const imageDataToCanvas = (img: ImageData): HTMLCanvasElement => {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (ctx) ctx.putImageData(img, 0, 0);
  return canvas;
};
