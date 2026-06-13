// 参照画像の取込ヘルパ: ファイル/カメラ -> ImageData、ImageData -> Blob、カメラ制御。

/**
 * File/Blob を ImageData に変換する。
 * - 最大辺が maxSize を超える場合は縦横比を保って縮小する
 * - EXIF回転は createImageBitmap の imageOrientation: 'from-image' により自動補正される
 */
export async function fileToImageData(file: Blob, maxSize = 2048): Promise<ImageData> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  try {
    const { width, height } = scaledSize(bitmap.width, bitmap.height, maxSize);
    return bitmapToImageData(bitmap, width, height);
  } finally {
    bitmap.close();
  }
}

/** ImageData を PNG 形式の Blob に変換する */
export function imageDataToBlob(img: ImageData): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = img.width;
  canvas.height = img.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return Promise.reject(new Error('2D context を取得できませんでした'));
  }
  ctx.putImageData(img, 0, 0);

  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Blob への変換に失敗しました'));
    }, 'image/png');
  });
}

/**
 * カメラストリームを開始し、video要素に紐付ける。
 * 背面カメラ優先（facingMode: 'environment'）。再生開始まで待機する。
 */
export async function startCamera(video: HTMLVideoElement): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });

  video.srcObject = stream;
  await video.play();

  return stream;
}

/** カメラストリームの全トラックを停止する */
export function stopCamera(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}

/**
 * video要素の現フレームを ImageData として取得する。
 * 最大辺が maxSize を超える場合は縦横比を保って縮小する。
 */
export function captureFrame(video: HTMLVideoElement, maxSize = 2048): ImageData {
  const srcW = video.videoWidth;
  const srcH = video.videoHeight;
  const { width, height } = scaledSize(srcW, srcH, maxSize);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context を取得できませんでした');
  }
  ctx.drawImage(video, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}

/** 縦横比を保って最大辺を maxSize 以下に縮小したサイズを返す（縮小不要なら元のサイズ） */
function scaledSize(srcW: number, srcH: number, maxSize: number): { width: number; height: number } {
  const longest = Math.max(srcW, srcH);
  if (longest <= maxSize || longest <= 0) {
    return { width: srcW, height: srcH };
  }
  const scale = maxSize / longest;
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

/** ImageBitmap を指定サイズに描画して ImageData として取り出す */
function bitmapToImageData(bitmap: ImageBitmap, width: number, height: number): ImageData {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('2D context を取得できませんでした');
  }
  ctx.drawImage(bitmap, 0, 0, width, height);
  return ctx.getImageData(0, 0, width, height);
}
