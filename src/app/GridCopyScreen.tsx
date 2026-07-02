// グリッド模写画面: 取込（ファイル/カメラ+台形補正）→ 練習（グリッド同期・セルフォーカス・オニオンスキン）→ 保存+評価
import { useCallback, useEffect, useRef, useState } from 'react';
import { fileToImageData, imageDataToBlob, startCamera, stopCamera, captureFrame } from '../reference/capture';
import { rectifyQuad, type Quad } from '../reference/homography';
import { drawGrid, drawGridLabels, cellRect } from '../reference/grid';
import { evaluateGridCopy, strokeStability, type GridEvalResult } from '../evaluation/quantitative';
import { DrawingEngine } from '../drawing/engine';
import { DEFAULT_BRUSH } from '../drawing/brush';
import {
  saveReferenceImage,
  savePrompt,
  saveSession,
  getUserStats,
  saveUserStats,
  getPrompt,
  getReferenceImage,
  getSession,
} from '../store/db';
import type { BrushConfig, Evaluation, Prompt, Session } from '../store/types';
import { getLlmState } from '../llm/runtime';
import { generateFeedback } from '../llm/services';
import { checkAndAdvanceStreak } from '../progression/streak';
import { xpForSession } from '../progression/xp';
import { EvaluationView } from './EvaluationView';
import { imageDataToCanvas, drawingToInkImageData } from './imageUtils';
import { SESSION_SAVED_EVENT } from './StreakBadge';
import type { RematchContext } from './App';
import './GridCopyScreen.css';

/** 練習ステップの参照・キャンバス表示の最大サイズ(px) */
const MAX_DISPLAY_SIZE = 560;
/** 取込・補正時の最大辺(px) */
const MAX_IMPORT_SIZE = 1024;

type Step = 'import' | 'rectify' | 'practice' | 'result';

/** 画像の四隅から少し内側に寄せた初期ハンドル位置(quad: 左上,右上,右下,左下) */
const initialQuad = (w: number, h: number): Quad => {
  const mx = w * 0.08;
  const my = h * 0.08;
  return [
    [mx, my],
    [w - mx, my],
    [w - mx, h - my],
    [mx, h - my],
  ];
};

/** ImageData を水平反転する */
const flipImageDataHorizontal = (img: ImageData): ImageData => {
  const { width, height, data } = img;
  const out = new ImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const srcI = (y * width + x) * 4;
      const dstI = (y * width + (width - 1 - x)) * 4;
      out.data[dstI] = data[srcI];
      out.data[dstI + 1] = data[srcI + 1];
      out.data[dstI + 2] = data[srcI + 2];
      out.data[dstI + 3] = data[srcI + 3];
    }
  }
  return out;
};

type Props = {
  /** 再戦中のコンテキスト（mode==='gridCopy' のときのみ渡される） */
  rematch: RematchContext | null;
  onClearRematch: () => void;
};

export const GridCopyScreen = ({ rematch, onClearRematch }: Props) => {
  const [step, setStep] = useState<Step>('import');

  // --- 取込・補正 ---
  const [rawImage, setRawImage] = useState<ImageData | null>(null);
  const [quad, setQuad] = useState<Quad | null>(null);
  const [cameraStream, setCameraStream] = useState<MediaStream | null>(null);
  const [cameraActive, setCameraActive] = useState(false);

  const videoRef = useRef<HTMLVideoElement>(null);
  const rectifyCanvasRef = useRef<HTMLCanvasElement>(null);
  const draggingHandleRef = useRef<number | null>(null);

  // --- 練習ステップ ---
  const [referenceImage, setReferenceImage] = useState<ImageData | null>(null);
  const [gridN, setGridN] = useState(4);
  const [onionOpacity, setOnionOpacity] = useState(0.4);
  const [flipH, setFlipH] = useState(false);
  const [focusCell, setFocusCell] = useState<{ row: number; col: number } | null>(null);
  const [focusShowReference, setFocusShowReference] = useState(true);

  const refCanvasRef = useRef<HTMLCanvasElement>(null);
  const refGridCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawGridCanvasRef = useRef<HTMLCanvasElement>(null);
  const onionCanvasRef = useRef<HTMLCanvasElement>(null);
  const focusCanvasRef = useRef<HTMLCanvasElement>(null);

  const engineRef = useRef<DrawingEngine | null>(null);
  const startedAtRef = useRef<number>(0);

  const [brush, setBrushState] = useState<BrushConfig>(DEFAULT_BRUSH);
  const [color, setColor] = useState('#f5f5f5');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [resetCounter, setResetCounter] = useState(0);

  // --- 結果ステップ ---
  const [evalResult, setEvalResult] = useState<GridEvalResult | null>(null);
  const [evalStability, setEvalStability] = useState(0);
  const [evalImage, setEvalImage] = useState<HTMLCanvasElement | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // --- LLM 講評 ---
  const [llmFeedback, setLlmFeedback] = useState<Evaluation['llmFeedback'] | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  // --- 再戦 ---
  const [rematchInfo, setRematchInfo] = useState<{ thumbUrl: string; ageDays: number | null } | null>(null);

  // 再戦コンテキスト反映: 当時の参照画像を復元して練習ステップから開始する
  useEffect(() => {
    if (!rematch) return;
    let cancelled = false;
    const url = URL.createObjectURL(rematch.thumbnailBlob);

    void (async () => {
      const [prompt, prevSession] = await Promise.all([
        getPrompt(rematch.promptId),
        getSession(rematch.sessionId),
      ]);
      if (cancelled) return;
      const ageDays = prevSession ? Math.round((Date.now() - prevSession.startedAt) / 86400000) : null;
      setRematchInfo({ thumbUrl: url, ageDays });
      if (prompt?.referenceImageId) {
        const blob = await getReferenceImage(prompt.referenceImageId);
        if (cancelled || !blob) return;
        const img = await fileToImageData(blob);
        if (cancelled) return;
        setReferenceImage(img);
        setStep('practice');
      }
    })();

    return () => {
      cancelled = true;
      setRematchInfo(null);
      URL.revokeObjectURL(url);
    };
  }, [rematch]);

  // ============================================================
  // 取込ステップ
  // ============================================================

  const handleFileChange = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = await fileToImageData(file, MAX_IMPORT_SIZE);
    setRawImage(img);
    setQuad(initialQuad(img.width, img.height));
    setStep('rectify');
    e.target.value = '';
  }, []);

  const handleStartCamera = useCallback(async () => {
    const video = videoRef.current;
    if (!video) return;
    try {
      const stream = await startCamera(video);
      setCameraStream(stream);
      setCameraActive(true);
    } catch {
      setToast('カメラを起動できませんでした');
      setTimeout(() => setToast(null), 2500);
    }
  }, []);

  const handleStopCamera = useCallback(() => {
    if (cameraStream) stopCamera(cameraStream);
    setCameraStream(null);
    setCameraActive(false);
  }, [cameraStream]);

  const handleCapture = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const img = captureFrame(video, MAX_IMPORT_SIZE);
    setRawImage(img);
    setQuad(initialQuad(img.width, img.height));
    if (cameraStream) stopCamera(cameraStream);
    setCameraStream(null);
    setCameraActive(false);
    setStep('rectify');
  }, [cameraStream]);

  // カメラ停止のクリーンアップ（アンマウント時）
  useEffect(() => {
    return () => {
      if (cameraStream) stopCamera(cameraStream);
    };
  }, [cameraStream]);

  // ============================================================
  // 台形補正ステップ
  // ============================================================

  // 補正キャンバスの表示倍率（rawImage を MAX_DISPLAY_SIZE 以内に縮小表示）
  const rectifyDisplayScale = rawImage
    ? Math.min(1, MAX_DISPLAY_SIZE / Math.max(rawImage.width, rawImage.height))
    : 1;

  // 補正キャンバスへ画像 + ハンドル + 結線を描画
  useEffect(() => {
    if (step !== 'rectify') return;
    const canvas = rectifyCanvasRef.current;
    if (!canvas || !rawImage || !quad) return;

    const w = Math.round(rawImage.width * rectifyDisplayScale);
    const h = Math.round(rawImage.height * rectifyDisplayScale);
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcCanvas = imageDataToCanvas(rawImage);
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(srcCanvas, 0, 0, w, h);

    // 結線（左上→右上→右下→左下→左上）
    ctx.save();
    ctx.strokeStyle = 'rgba(0, 200, 255, 0.8)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    quad.forEach(([x, y], i) => {
      const px = x * rectifyDisplayScale;
      const py = y * rectifyDisplayScale;
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.stroke();

    // ハンドル
    quad.forEach(([x, y]) => {
      const px = x * rectifyDisplayScale;
      const py = y * rectifyDisplayScale;
      ctx.beginPath();
      ctx.arc(px, py, 10, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 200, 255, 0.9)';
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = '#ffffff';
      ctx.stroke();
    });
    ctx.restore();
  }, [step, rawImage, quad, rectifyDisplayScale]);

  const handleRectifyPointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!quad) return;
    const canvas = rectifyCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);

    // 最も近いハンドルを選択（一定距離以内）
    let nearest = -1;
    let nearestDist = Infinity;
    quad.forEach(([x, y], i) => {
      const dx = x * rectifyDisplayScale - px;
      const dy = y * rectifyDisplayScale - py;
      const dist = Math.hypot(dx, dy);
      if (dist < nearestDist) {
        nearestDist = dist;
        nearest = i;
      }
    });
    if (nearest >= 0 && nearestDist < 30) {
      draggingHandleRef.current = nearest;
      canvas.setPointerCapture?.(e.pointerId);
    }
  }, [quad, rectifyDisplayScale]);

  const handleRectifyPointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    const idx = draggingHandleRef.current;
    if (idx === null || !quad || !rawImage) return;
    const canvas = rectifyCanvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = (e.clientX - rect.left) * (canvas.width / rect.width);
    const py = (e.clientY - rect.top) * (canvas.height / rect.height);

    const x = Math.min(Math.max(px / rectifyDisplayScale, 0), rawImage.width);
    const y = Math.min(Math.max(py / rectifyDisplayScale, 0), rawImage.height);

    const next: Quad = [...quad] as Quad;
    next[idx] = [x, y];
    setQuad(next);
  }, [quad, rawImage, rectifyDisplayScale]);

  const handleRectifyPointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    draggingHandleRef.current = null;
    rectifyCanvasRef.current?.releasePointerCapture?.(e.pointerId);
  }, []);

  /** quad の各辺の長さから出力サイズを決定（最大1024、縦横比は辺長から推定） */
  const computeRectifySize = useCallback((q: Quad): { w: number; h: number } => {
    const dist = (a: [number, number], b: [number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1]);
    const topW = dist(q[0], q[1]);
    const bottomW = dist(q[3], q[2]);
    const leftH = dist(q[0], q[3]);
    const rightH = dist(q[1], q[2]);
    const w = Math.max(1, (topW + bottomW) / 2);
    const h = Math.max(1, (leftH + rightH) / 2);
    const longest = Math.max(w, h);
    const scale = longest > MAX_IMPORT_SIZE ? MAX_IMPORT_SIZE / longest : 1;
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
  }, []);

  const handleRectifyConfirm = useCallback(() => {
    if (!rawImage || !quad) return;
    const { w, h } = computeRectifySize(quad);
    const rectified = rectifyQuad(rawImage, quad, w, h);
    setReferenceImage(rectified);
    setStep('practice');
  }, [rawImage, quad, computeRectifySize]);

  const handleRectifySkip = useCallback(() => {
    if (!rawImage) return;
    setReferenceImage(rawImage);
    setStep('practice');
  }, [rawImage]);

  const handleBackToImport = useCallback(() => {
    setRawImage(null);
    setQuad(null);
    setStep('import');
  }, []);

  // ============================================================
  // 練習ステップ
  // ============================================================

  // 参照画像の表示サイズ（最大560pxにフィット、アスペクト比保持）
  const displaySize = (() => {
    if (!referenceImage) return { w: MAX_DISPLAY_SIZE, h: MAX_DISPLAY_SIZE };
    const scale = Math.min(1, MAX_DISPLAY_SIZE / Math.max(referenceImage.width, referenceImage.height));
    return {
      w: Math.max(1, Math.round(referenceImage.width * scale)),
      h: Math.max(1, Math.round(referenceImage.height * scale)),
    };
  })();

  // 参照画像描画（左右反転チェック対応）
  useEffect(() => {
    if (step !== 'practice') return;
    const canvas = refCanvasRef.current;
    if (!canvas || !referenceImage) return;
    canvas.width = displaySize.w;
    canvas.height = displaySize.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcCanvas = imageDataToCanvas(referenceImage);
    ctx.save();
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);
    if (flipH) {
      ctx.translate(displaySize.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(srcCanvas, 0, 0, displaySize.w, displaySize.h);
    ctx.restore();
  }, [step, referenceImage, displaySize.w, displaySize.h, flipH]);

  // 参照グリッドオーバーレイ描画
  useEffect(() => {
    if (step !== 'practice') return;
    const canvas = refGridCanvasRef.current;
    if (!canvas) return;
    canvas.width = displaySize.w;
    canvas.height = displaySize.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);
    drawGrid(ctx, displaySize.w, displaySize.h, gridN);
    drawGridLabels(ctx, displaySize.w, displaySize.h, gridN);
  }, [step, displaySize.w, displaySize.h, gridN]);

  // 描画グリッドオーバーレイ描画（参照と同期）
  useEffect(() => {
    if (step !== 'practice') return;
    const canvas = drawGridCanvasRef.current;
    if (!canvas) return;
    canvas.width = displaySize.w;
    canvas.height = displaySize.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);
    drawGrid(ctx, displaySize.w, displaySize.h, gridN);
    drawGridLabels(ctx, displaySize.w, displaySize.h, gridN);
  }, [step, displaySize.w, displaySize.h, gridN]);

  // オニオンスキン描画（参照画像を透過表示、反転対応）
  useEffect(() => {
    if (step !== 'practice') return;
    const canvas = onionCanvasRef.current;
    if (!canvas || !referenceImage) return;
    canvas.width = displaySize.w;
    canvas.height = displaySize.h;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const srcCanvas = imageDataToCanvas(referenceImage);
    ctx.save();
    ctx.clearRect(0, 0, displaySize.w, displaySize.h);
    ctx.globalAlpha = onionOpacity;
    if (flipH) {
      ctx.translate(displaySize.w, 0);
      ctx.scale(-1, 1);
    }
    ctx.drawImage(srcCanvas, 0, 0, displaySize.w, displaySize.h);
    ctx.restore();
  }, [step, referenceImage, displaySize.w, displaySize.h, onionOpacity, flipH]);

  // 描画エンジン生成・破棄
  useEffect(() => {
    if (step !== 'practice') return;
    const canvas = drawCanvasRef.current;
    if (!canvas) return;

    const engine = new DrawingEngine(canvas, { width: displaySize.w, height: displaySize.h });
    engine.attachInput();
    engine.setBrush(brush);
    engine.setColor(color);
    engine.setActiveLayer('sketch');
    engine.onChange = () => {
      setCanUndo(engine.canUndo());
      setCanRedo(engine.canRedo());
    };
    engineRef.current = engine;
    startedAtRef.current = Date.now();
    setCanUndo(engine.canUndo());
    setCanRedo(engine.canRedo());

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // displaySize / step が変わるたびに再生成（resetCounter は新規キャンバス用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, displaySize.w, displaySize.h, resetCounter]);

  useEffect(() => {
    engineRef.current?.setBrush(brush);
  }, [brush]);

  useEffect(() => {
    engineRef.current?.setColor(color);
  }, [color]);

  const handleUndo = useCallback(() => engineRef.current?.undo(), []);
  const handleRedo = useCallback(() => engineRef.current?.redo(), []);
  const handleClear = useCallback(() => engineRef.current?.clearLayer('sketch'), []);

  // ============================================================
  // セルフォーカスモード
  // ============================================================

  // フォーカスキャンバスへ拡大表示
  useEffect(() => {
    if (!focusCell) return;
    const canvas = focusCanvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const size = 360;
    canvas.width = size;
    canvas.height = size;
    ctx.clearRect(0, 0, size, size);

    if (focusShowReference && referenceImage) {
      const refW = referenceImage.width;
      const refH = referenceImage.height;
      const srcCanvas = imageDataToCanvas(referenceImage);
      const rect = cellRect(refW, refH, gridN, focusCell.row, focusCell.col);

      ctx.save();
      if (flipH) {
        // 反転表示時は列インデックスを反転させたセルを切り出す
        const flippedCol = gridN - 1 - focusCell.col;
        const flippedRect = cellRect(refW, refH, gridN, focusCell.row, flippedCol);
        ctx.translate(size, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(
          srcCanvas,
          flippedRect.x, flippedRect.y, flippedRect.w, flippedRect.h,
          0, 0, size, size,
        );
      } else {
        ctx.drawImage(srcCanvas, rect.x, rect.y, rect.w, rect.h, 0, 0, size, size);
      }
      ctx.restore();
    } else {
      const engine = engineRef.current;
      const drawCanvas = drawCanvasRef.current;
      if (engine && drawCanvas) {
        const rect = cellRect(displaySize.w, displaySize.h, gridN, focusCell.row, focusCell.col);
        // engine の合成結果は targetCanvas (drawCanvas) に描かれている（device px = CSS px * dpr）
        const dpr = drawCanvas.width / displaySize.w;
        ctx.drawImage(
          drawCanvas,
          rect.x * dpr, rect.y * dpr, rect.w * dpr, rect.h * dpr,
          0, 0, size, size,
        );
      }
    }
  }, [focusCell, focusShowReference, referenceImage, gridN, flipH, displaySize.w, displaySize.h]);

  const handleGridClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    const col = Math.min(gridN - 1, Math.max(0, Math.floor((x / rect.width) * gridN)));
    const row = Math.min(gridN - 1, Math.max(0, Math.floor((y / rect.height) * gridN)));
    setFocusCell({ row, col });
    setFocusShowReference(true);
  }, [gridN]);

  // ============================================================
  // 別の画像にする / 保存+評価
  // ============================================================

  const handleChangeImage = useCallback(() => {
    setReferenceImage(null);
    setRawImage(null);
    setQuad(null);
    setFocusCell(null);
    setEvalResult(null);
    setStep('import');
    if (rematch) onClearRematch();
  }, [rematch, onClearRematch]);

  const handleSave = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine || !referenceImage) return;
    setSaving(true);
    setLlmFeedback(null);

    try {
      // 1. 参照画像を保存
      const referenceId = crypto.randomUUID();
      const referenceBlob = await imageDataToBlob(referenceImage);
      await saveReferenceImage(referenceId, referenceBlob);

      // 2. Prompt 保存
      const prompt: Prompt = {
        id: `grid-${referenceId.slice(0, 8)}`,
        source: 'template',
        text: 'グリッド模写',
        category: 'still',
        referenceImageId: referenceId,
      };
      await savePrompt(prompt);

      // 3. ユーザーの絵を「白地に黒インク」へ正規化して評価（線の色に依存させない）
      const drawingBlob = await engine.exportImage();
      const drawingImage = await drawingToInkImageData(drawingBlob);

      // 反転チェックON時は参照を水平反転してから評価する
      const evalReference = flipH ? flipImageDataHorizontal(referenceImage) : referenceImage;

      const result = evaluateGridCopy(evalReference, drawingImage, gridN);
      const strokes = engine.getStrokes().map((s) => s.stroke);
      const stability = strokeStability(strokes);

      // 4. Session 保存
      const now = Date.now();
      const sessionId = crypto.randomUUID();
      const evaluation: Evaluation = {
        quantitative: {
          cellScores: result.cellScores,
          centroidOffsets: result.centroidOffsets,
          strokeStability: stability,
        },
      };
      const session: Session = {
        id: sessionId,
        promptId: prompt.id,
        strokes,
        thumbnailBlob: await engine.exportImage(256),
        mode: 'gridCopy',
        startedAt: startedAtRef.current || now,
        durationMs: now - (startedAtRef.current || now),
        evaluation,
      };
      await saveSession(session);

      // 5. 弱点出題のためカテゴリ別 EMA スコアを更新 + XP加算
      const stats = await getUserStats();
      const prev = stats.categoryScores[prompt.category];
      const nextEma = prev ? prev.ema * 0.7 + result.overall * 0.3 : result.overall;
      const nextN = (prev?.n ?? 0) + 1;
      const xpGain = xpForSession(result.overall, prompt.source === 'daily');
      await saveUserStats({
        ...stats,
        categoryScores: { ...stats.categoryScores, [prompt.category]: { ema: nextEma, n: nextN } },
        xp: stats.xp + xpGain,
      });

      // ストリーク更新判定（結果は捨ててよい。イベントでヘッダーが再取得する）
      void checkAndAdvanceStreak();
      window.dispatchEvent(new CustomEvent(SESSION_SAVED_EVENT));

      // 6. 評価結果パネルを表示
      setEvalResult(result);
      setEvalStability(stability);
      setEvalImage(imageDataToCanvas(drawingImage));
      setStep('result');

      // 7. 講評は非同期生成（UI をブロックしない）。LLM 未ロード時は null が返り枠は非表示のまま。
      if (getLlmState().status === 'ready') {
        setFeedbackLoading(true);
        void generateFeedback(drawingBlob, evaluation, 'gridCopy')
          .then(async (feedback) => {
            if (!feedback) return;
            setLlmFeedback(feedback);
            await saveSession({ ...session, evaluation: { ...evaluation, llmFeedback: feedback } });
          })
          .finally(() => setFeedbackLoading(false));
      }
    } catch {
      setToast('保存に失敗しました');
      setTimeout(() => setToast(null), 2500);
    } finally {
      setSaving(false);
    }
  }, [referenceImage, gridN, flipH]);

  const handleNextPractice = useCallback(() => {
    setEvalResult(null);
    setEvalImage(null);
    setLlmFeedback(null);
    setFeedbackLoading(false);
    setReferenceImage(null);
    setRawImage(null);
    setQuad(null);
    setFocusCell(null);
    setCanUndo(false);
    setCanRedo(false);
    setResetCounter((c) => c + 1);
    setStep('import');
    if (rematch) onClearRematch();
  }, [rematch, onClearRematch]);

  // ============================================================
  // レンダリング
  // ============================================================

  return (
    <div className="grid-copy-screen">
      {step === 'import' && (
        <div className="grid-copy-import">
          <h2>参照画像を取り込む</h2>

          <div className="import-section">
            <h3>ファイルから取り込み</h3>
            <input type="file" accept="image/*" onChange={handleFileChange} />
          </div>

          <div className="import-section">
            <h3>カメラで撮影</h3>
            {!cameraActive ? (
              <button className="btn btn-primary" onClick={handleStartCamera}>
                カメラを起動
              </button>
            ) : (
              <div className="camera-wrap">
                <video ref={videoRef} className="camera-video" playsInline muted />
                <div className="button-row">
                  <button className="btn btn-primary" onClick={handleCapture}>
                    シャッター
                  </button>
                  <button className="btn" onClick={handleStopCamera}>
                    キャンセル
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {step === 'rectify' && rawImage && quad && (
        <div className="grid-copy-rectify">
          <h2>台形補正</h2>
          <p className="rectify-hint">4つのハンドルをドラッグして紙の四隅に合わせてください</p>
          <canvas
            ref={rectifyCanvasRef}
            className="rectify-canvas"
            onPointerDown={handleRectifyPointerDown}
            onPointerMove={handleRectifyPointerMove}
            onPointerUp={handleRectifyPointerUp}
            onPointerCancel={handleRectifyPointerUp}
          />
          <div className="button-row">
            <button className="btn btn-primary" onClick={handleRectifyConfirm}>
              補正して使用
            </button>
            <button className="btn" onClick={handleRectifySkip}>
              補正せずそのまま使用
            </button>
            <button className="btn" onClick={handleBackToImport}>
              取込に戻る
            </button>
          </div>
        </div>
      )}

      {step === 'practice' && referenceImage && (
        <div className="grid-copy-practice">
          {rematchInfo && (
            <div className="rematch-panel">
              <img src={rematchInfo.thumbUrl} alt="前回の絵" className="rematch-panel-thumb" />
              <span className="rematch-panel-label">
                前回の絵{rematchInfo.ageDays !== null ? `（${rematchInfo.ageDays}日前）` : ''}
              </span>
            </div>
          )}
          <div className="practice-main">
            <div
              className="practice-pane reference-pane"
              style={{ width: displaySize.w, height: displaySize.h }}
              onClick={handleGridClick}
            >
              <canvas ref={refCanvasRef} className="practice-canvas reference-canvas" />
              <canvas ref={refGridCanvasRef} className="practice-canvas grid-overlay" />
            </div>

            <div
              className="practice-pane draw-pane"
              style={{ width: displaySize.w, height: displaySize.h }}
            >
              <canvas ref={onionCanvasRef} className="practice-canvas onion-canvas" />
              <canvas ref={drawCanvasRef} className="practice-canvas draw-canvas-inner" />
              <canvas ref={drawGridCanvasRef} className="practice-canvas grid-overlay" />
            </div>
          </div>

          <div className="toolbar">
            <label className="tool-item">
              <span>グリッド分割数: {gridN}</span>
              <input
                type="range"
                min={2}
                max={8}
                step={1}
                value={gridN}
                onChange={(e) => setGridN(Number(e.target.value))}
              />
            </label>

            <label className="tool-item">
              <span>オニオンスキン透過率: {Math.round(onionOpacity * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={onionOpacity}
                onChange={(e) => setOnionOpacity(Number(e.target.value))}
              />
            </label>

            <label className="checkbox-label tool-item">
              <input type="checkbox" checked={flipH} onChange={(e) => setFlipH(e.target.checked)} />
              左右反転（参照画像）
            </label>

            <label className="tool-item">
              <span>色</span>
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>

            <label className="tool-item">
              <span>ブラシサイズ: {brush.size}px</span>
              <input
                type="range"
                min={1}
                max={64}
                step={1}
                value={brush.size}
                onChange={(e) => setBrushState((prev) => ({ ...prev, size: Number(e.target.value) }))}
              />
            </label>

            <label className="tool-item">
              <span>不透明度: {Math.round(brush.opacity * 100)}%</span>
              <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={brush.opacity}
                onChange={(e) => setBrushState((prev) => ({ ...prev, opacity: Number(e.target.value) }))}
              />
            </label>

            <div className="tool-item">
              <span>操作</span>
              <div className="button-row">
                <button className="btn" onClick={handleUndo} disabled={!canUndo}>
                  元に戻す
                </button>
                <button className="btn" onClick={handleRedo} disabled={!canRedo}>
                  やり直す
                </button>
              </div>
            </div>

            <div className="tool-item">
              <span>クリア</span>
              <button className="btn btn-danger" onClick={handleClear}>
                キャンバスをクリア
              </button>
            </div>

            <div className="tool-item">
              <span>画像</span>
              <button className="btn" onClick={handleChangeImage}>
                別の画像にする
              </button>
            </div>

            <div className="tool-item">
              <span>保存+評価</span>
              <button className="btn btn-primary" onClick={handleSave} disabled={saving}>
                保存
              </button>
            </div>
          </div>

          {focusCell && (
            <div className="focus-overlay" onClick={() => setFocusCell(null)}>
              <div className="focus-modal" onClick={(e) => e.stopPropagation()}>
                <div className="focus-header">
                  <h3>セルフォーカス</h3>
                  <button className="btn" onClick={() => setFocusCell(null)}>
                    閉じる
                  </button>
                </div>
                <canvas ref={focusCanvasRef} className="focus-canvas" />
                <div className="button-row">
                  <button
                    className={`btn ${focusShowReference ? 'btn-primary' : ''}`}
                    onClick={() => setFocusShowReference(true)}
                  >
                    参照
                  </button>
                  <button
                    className={`btn ${!focusShowReference ? 'btn-primary' : ''}`}
                    onClick={() => setFocusShowReference(false)}
                  >
                    自分の絵
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {step === 'result' && evalResult && (
        <div className="grid-copy-result">
          <h2>評価結果</h2>
          {rematchInfo && evalImage && (
            <div className="rematch-compare">
              <div className="rematch-compare-pane">
                <span className="rematch-compare-label">
                  前回{rematchInfo.ageDays !== null ? `（${rematchInfo.ageDays}日前）` : ''}
                </span>
                <img src={rematchInfo.thumbUrl} alt="前回の絵" className="rematch-compare-img" />
              </div>
              <div className="rematch-compare-pane">
                <span className="rematch-compare-label">今回</span>
                <img src={evalImage.toDataURL()} alt="今回の絵" className="rematch-compare-img" />
              </div>
            </div>
          )}
          <EvaluationView
            result={evalResult}
            stability={evalStability}
            image={evalImage}
            feedback={llmFeedback}
            feedbackLoading={feedbackLoading}
          />
          <div className="button-row">
            <button className="btn btn-primary" onClick={handleNextPractice}>
              次の練習へ
            </button>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
