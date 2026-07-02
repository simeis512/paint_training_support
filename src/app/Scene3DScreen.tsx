// 3Dデッサン画面: 3Dビュー（Scene3DView） + 描画キャンバス（DrawingEngine）
import { useCallback, useEffect, useRef, useState } from 'react';
import { Scene3DView, type RenderMode } from '../scene3d/view';
import type { Difficulty } from '../scene3d/generator';
import type { LightPreset, ShadingSteps } from '../scene3d/shading';
import { DrawingEngine } from '../drawing/engine';
import { DEFAULT_BRUSH } from '../drawing/brush';
import { evaluate3D, strokeStability, type GridEvalResult } from '../evaluation/quantitative';
import { saveSession, savePrompt, getUserStats, saveUserStats } from '../store/db';
import type { BrushConfig, Category, Evaluation, Prompt, Session } from '../store/types';
import { getLlmState, subscribeLlm } from '../llm/runtime';
import { generateMitatePrompt, generateFeedback } from '../llm/services';
import { EvaluationView } from './EvaluationView';
import { imageDataToCanvas, drawingToInkImageData } from './imageUtils';
import './Scene3DScreen.css';

/** rAF 内で描画バッファをキャプチャする（preserveDrawingBuffer:false 対策）。フレーム外だと空になる。 */
const captureCanvasFrame = (canvas: HTMLCanvasElement): Promise<HTMLCanvasElement> =>
  new Promise((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const tmp = document.createElement('canvas');
        tmp.width = canvas.width;
        tmp.height = canvas.height;
        const ctx = tmp.getContext('2d');
        ctx?.drawImage(canvas, 0, 0);
        resolve(tmp);
      });
    });
  });

/** 3Dモード評価のグリッド分割数 */
const EVAL_GRID_N = 4;

const VIEW_SIZE = 480;
const CANVAS_SIZE = 480;

const DIFFICULTY_LABELS: { value: Difficulty; label: string }[] = [
  { value: 1, label: '①単体' },
  { value: 2, label: '②複数' },
  { value: 3, label: '③相互貫入' },
];

/** outline.ts のデフォルト値に合わせる */
const DEFAULT_OUTLINE = { depthThreshold: 0.06, normalThreshold: 0.6, thickness: 1.5 };

/** 描く前は確認フェーズ（回転可・描画不可）、描き始めると描画フェーズ（ビュー固定）、保存後は結果フェーズ */
type Phase = 'preview' | 'drawing' | 'result';

const randomSeed = (): number => Math.floor(Math.random() * 2 ** 31);

export const Scene3DScreen = () => {
  const viewCanvasRef = useRef<HTMLCanvasElement>(null);
  const drawCanvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<Scene3DView | null>(null);
  const engineRef = useRef<DrawingEngine | null>(null);
  const startedAtRef = useRef<number>(0);

  const [seed, setSeed] = useState<number>(() => randomSeed());
  const [seedInput, setSeedInput] = useState<string>(String(seed));
  const [difficulty, setDifficulty] = useState<Difficulty>(1);
  const [phase, setPhase] = useState<Phase>('preview');

  const [renderMode, setRenderMode] = useState<RenderMode>('line');
  const [depthThreshold, setDepthThreshold] = useState(DEFAULT_OUTLINE.depthThreshold);
  const [normalThreshold, setNormalThreshold] = useState(DEFAULT_OUTLINE.normalThreshold);
  const [thickness, setThickness] = useState(DEFAULT_OUTLINE.thickness);
  const [lightPreset, setLightPreset] = useState<LightPreset>('threePoint');
  const [shadingSteps, setShadingSteps] = useState<ShadingSteps>(3);

  // 描画ツールバー用ステート（DrawScreen と同等の最小構成）
  const [brush, setBrushState] = useState<BrushConfig>(DEFAULT_BRUSH);
  const [color, setColor] = useState('#f5f5f5');
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [resetCounter, setResetCounter] = useState(0);
  const [toast, setToast] = useState<string | null>(null);

  // --- 評価結果 ---
  const [evalResult, setEvalResult] = useState<GridEvalResult | null>(null);
  const [evalStability, setEvalStability] = useState(0);
  const [evalImage, setEvalImage] = useState<HTMLCanvasElement | null>(null);
  const [saving, setSaving] = useState(false);

  // --- LLM 講評 ---
  const [llmFeedback, setLlmFeedback] = useState<Evaluation['llmFeedback'] | null>(null);
  const [feedbackLoading, setFeedbackLoading] = useState(false);

  // --- 見立てお題（AI）---
  const DEFAULT_PROMPT_TEXT = 'この3D構図を線画でデッサンする';
  const [promptText, setPromptText] = useState(DEFAULT_PROMPT_TEXT);
  const [promptSource, setPromptSource] = useState<'template' | 'llm'>('template');
  const [mitateLoading, setMitateLoading] = useState(false);
  const [llmReady, setLlmReady] = useState(getLlmState().status === 'ready');

  // --- LLM 状態購読（ready かどうかのみ使う） ---
  useEffect(() => subscribeLlm((s) => setLlmReady(s.status === 'ready')), []);

  // --- Scene3DView 生成・破棄（マウント時のみ） ---
  useEffect(() => {
    const canvas = viewCanvasRef.current;
    if (!canvas) return;

    const view = new Scene3DView(canvas, { width: VIEW_SIZE, height: VIEW_SIZE });
    viewRef.current = view;

    return () => {
      view.dispose();
      viewRef.current = null;
    };
  }, []);

  // --- 描画エンジン生成・破棄（保存後の新規キャンバス用に resetCounter で再生成） ---
  useEffect(() => {
    const canvas = drawCanvasRef.current;
    if (!canvas) return;

    const engine = new DrawingEngine(canvas, { width: CANVAS_SIZE, height: CANVAS_SIZE });
    engine.attachInput();
    engine.setBrush(brush);
    engine.setColor(color);
    engine.setActiveLayer('sketch');
    engine.onChange = () => {
      setCanUndo(engine.canUndo());
      setCanRedo(engine.canRedo());
    };
    engineRef.current = engine;
    setCanUndo(engine.canUndo());
    setCanRedo(engine.canRedo());

    return () => {
      engine.destroy();
      engineRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCounter]);

  useEffect(() => {
    engineRef.current?.setBrush(brush);
  }, [brush]);

  useEffect(() => {
    engineRef.current?.setColor(color);
  }, [color]);

  // --- お題ロード ---
  const loadScene = useCallback((nextSeed: number, nextDifficulty: Difficulty) => {
    const view = viewRef.current;
    if (!view) return;

    view.loadScene(nextSeed, nextDifficulty);
    view.setRenderMode(renderMode);
    view.setOutlineParams({ depthThreshold, normalThreshold, thickness });
    view.setLightPreset(lightPreset);
    view.setShadingSteps(shadingSteps);
    view.enableOrbit();

    setSeed(nextSeed);
    setSeedInput(String(nextSeed));
    setPhase('preview');
    setPromptText(DEFAULT_PROMPT_TEXT);
    setPromptSource('template');
  }, [renderMode, depthThreshold, normalThreshold, thickness, lightPreset, shadingSteps]);

  // 初回ロード（Scene3DView 生成後に実行）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.loadScene(seed, difficulty);
    view.setRenderMode(renderMode);
    view.setOutlineParams({ depthThreshold, normalThreshold, thickness });
    view.setLightPreset(lightPreset);
    view.setShadingSteps(shadingSteps);
    view.enableOrbit();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- 表示モード・パラメータの反映（描画フェーズ中も変更可） ---
  useEffect(() => {
    viewRef.current?.setRenderMode(renderMode);
  }, [renderMode]);

  useEffect(() => {
    viewRef.current?.setOutlineParams({ depthThreshold, normalThreshold, thickness });
  }, [depthThreshold, normalThreshold, thickness]);

  useEffect(() => {
    viewRef.current?.setLightPreset(lightPreset);
  }, [lightPreset]);

  useEffect(() => {
    viewRef.current?.setShadingSteps(shadingSteps);
  }, [shadingSteps]);

  // --- お題操作 ---
  const handleNewPrompt = useCallback(() => {
    loadScene(randomSeed(), difficulty);
  }, [loadScene, difficulty]);

  const handleSeedInputCommit = useCallback(() => {
    const parsed = Number(seedInput);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      setSeedInput(String(seed));
      return;
    }
    loadScene(parsed, difficulty);
  }, [seedInput, seed, difficulty, loadScene]);

  const handleDifficultyChange = useCallback((next: Difficulty) => {
    setDifficulty(next);
    loadScene(seed, next);
  }, [seed, loadScene]);

  // --- フェーズ遷移 ---
  const handleStartDrawing = useCallback(() => {
    const view = viewRef.current;
    if (!view) return;
    view.lockView();
    startedAtRef.current = Date.now();
    setPhase('drawing');
  }, []);

  // --- AIに見立てお題を頼む ---
  const handleMitatePrompt = useCallback(async () => {
    const view = viewRef.current;
    const canvas = viewCanvasRef.current;
    const spec = view?.currentSpec;
    if (!view || !canvas || !spec) return;

    setMitateLoading(true);
    try {
      // WebGL は preserveDrawingBuffer:false のため、rAF フレーム内で drawImage する必要がある
      const tmpCanvas = await captureCanvasFrame(canvas);
      const { text, source } = await generateMitatePrompt(tmpCanvas, spec);
      setPromptText(text);
      setPromptSource(source);
    } finally {
      setMitateLoading(false);
    }
  }, []);

  // --- 描画ツールバー操作 ---
  const handleUndo = useCallback(() => {
    engineRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    engineRef.current?.redo();
  }, []);

  const handleClear = useCallback(() => {
    engineRef.current?.clearLayer('sketch');
  }, []);

  // --- 保存 ---
  const handleSave = useCallback(async () => {
    const engine = engineRef.current;
    const view = viewRef.current;
    if (!engine || !view) return;
    setSaving(true);
    setLlmFeedback(null);

    try {
      const thumbnailBlob = await engine.exportImage(256);
      const strokes = engine.getStrokes().map((s) => s.stroke);

      const now = Date.now();
      const promptId = `p3d-${seed}-${difficulty}`;
      const category: Category = 'perspective';

      const prompt: Prompt = {
        id: promptId,
        source: promptSource,
        text: promptText,
        category,
        scene3dSeed: seed,
      };
      await savePrompt(prompt);

      // 正解エッジマップと描画を比較して定量評価
      const gt = view.captureGroundTruth();
      const drawingBlob = await engine.exportImage();
      // 白地に黒インクへ正規化（白系ブラシでも評価で線が消えないように）
      const drawingImage = await drawingToInkImageData(drawingBlob);
      const result = evaluate3D(gt.edgeMap, drawingImage, EVAL_GRID_N);
      const stability = strokeStability(strokes);

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
        promptId,
        strokes,
        thumbnailBlob,
        mode: 'primitive3d',
        startedAt: startedAtRef.current || now,
        durationMs: now - (startedAtRef.current || now),
        evaluation,
      };
      await saveSession(session);

      // 弱点出題のためカテゴリ別 EMA スコアを更新
      const stats = await getUserStats();
      const prev = stats.categoryScores[category];
      const nextEma = prev ? prev.ema * 0.7 + result.overall * 0.3 : result.overall;
      const nextN = (prev?.n ?? 0) + 1;
      await saveUserStats({
        ...stats,
        categoryScores: { ...stats.categoryScores, [category]: { ema: nextEma, n: nextN } },
      });

      setEvalResult(result);
      setEvalStability(stability);
      setEvalImage(imageDataToCanvas(drawingImage));
      setPhase('result');

      // 講評は非同期生成（UI をブロックしない）。LLM 未ロード時は null が返り枠は非表示のまま。
      if (getLlmState().status === 'ready') {
        setFeedbackLoading(true);
        void generateFeedback(drawingBlob, evaluation, 'primitive3d')
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
  }, [seed, difficulty, promptText, promptSource]);

  // --- 結果確認後: 次のお題へ ---
  const handleNextPrompt = useCallback(() => {
    setEvalResult(null);
    setEvalImage(null);
    setLlmFeedback(null);
    setFeedbackLoading(false);
    setCanUndo(false);
    setCanRedo(false);
    setResetCounter((c) => c + 1);
    loadScene(randomSeed(), difficulty);
  }, [loadScene, difficulty]);

  return (
    <div className="scene3d-screen">
      <div className="scene3d-main">
        <div className="scene3d-view-wrap">
          <canvas ref={viewCanvasRef} className="scene3d-view-canvas" />
          {phase === 'preview' && (
            <div className="scene3d-overlay">
              <p>構図を確認したら描き始めてください</p>
              <button className="btn btn-primary" onClick={handleStartDrawing}>
                描き始める
              </button>
            </div>
          )}
        </div>

        <div className="canvas-wrap scene3d-draw-wrap">
          <canvas ref={drawCanvasRef} className="draw-canvas" />
          {phase === 'preview' && <div className="scene3d-draw-disabled" />}
        </div>
      </div>

      <div className="scene3d-prompt-text">
        <span>{promptText}</span>
        {promptSource === 'llm' && <span className="prompt-badge">AI出題</span>}
      </div>

      <div className="toolbar">
        <div className="tool-item">
          <span>難易度</span>
          <div className="button-row">
            {DIFFICULTY_LABELS.map(({ value, label }) => (
              <button
                key={value}
                className={`btn ${difficulty === value ? 'btn-primary' : ''}`}
                onClick={() => handleDifficultyChange(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="tool-item">
          <span>お題</span>
          <div className="button-row">
            <button className="btn btn-primary" onClick={handleNewPrompt}>
              新しいお題
            </button>
            <button
              className="btn"
              onClick={handleMitatePrompt}
              disabled={!llmReady || mitateLoading}
              title={llmReady ? undefined : 'LLMがロードされると使えます（ヘッダーの状態表示からロードできます）'}
            >
              {mitateLoading ? <span className="btn-spinner" /> : 'AIに見立てお題を頼む'}
            </button>
          </div>
        </div>

        <label className="tool-item">
          <span>シード</span>
          <input
            type="number"
            className="seed-input"
            value={seedInput}
            onChange={(e) => setSeedInput(e.target.value)}
            onBlur={handleSeedInputCommit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSeedInputCommit();
            }}
          />
        </label>

        <div className="tool-item">
          <span>表示モード</span>
          <div className="button-row">
            <button
              className={`btn ${renderMode === 'line' ? 'btn-primary' : ''}`}
              onClick={() => setRenderMode('line')}
            >
              線画
            </button>
            <button
              className={`btn ${renderMode === 'shaded' ? 'btn-primary' : ''}`}
              onClick={() => setRenderMode('shaded')}
            >
              陰影
            </button>
            <button
              className={`btn ${renderMode === 'wireframe' ? 'btn-primary' : ''}`}
              onClick={() => setRenderMode('wireframe')}
            >
              ワイヤーフレーム
            </button>
          </div>
        </div>

        {renderMode === 'line' && (
          <>
            <label className="tool-item">
              <span>深度閾値: {depthThreshold.toFixed(3)}</span>
              <input
                type="range"
                min={0.01}
                max={0.3}
                step={0.005}
                value={depthThreshold}
                onChange={(e) => setDepthThreshold(Number(e.target.value))}
              />
            </label>
            <label className="tool-item">
              <span>法線閾値: {normalThreshold.toFixed(2)}</span>
              <input
                type="range"
                min={0.1}
                max={1.5}
                step={0.05}
                value={normalThreshold}
                onChange={(e) => setNormalThreshold(Number(e.target.value))}
              />
            </label>
            <label className="tool-item">
              <span>線の太さ: {thickness.toFixed(1)}</span>
              <input
                type="range"
                min={1}
                max={3}
                step={0.1}
                value={thickness}
                onChange={(e) => setThickness(Number(e.target.value))}
              />
            </label>
          </>
        )}

        {renderMode === 'shaded' && (
          <>
            <div className="tool-item">
              <span>ライトプリセット</span>
              <div className="button-row">
                <button
                  className={`btn ${lightPreset === 'key1' ? 'btn-primary' : ''}`}
                  onClick={() => setLightPreset('key1')}
                >
                  1灯
                </button>
                <button
                  className={`btn ${lightPreset === 'threePoint' ? 'btn-primary' : ''}`}
                  onClick={() => setLightPreset('threePoint')}
                >
                  3点
                </button>
              </div>
            </div>
            <div className="tool-item">
              <span>段階</span>
              <div className="button-row">
                <button
                  className={`btn ${shadingSteps === 2 ? 'btn-primary' : ''}`}
                  onClick={() => setShadingSteps(2)}
                >
                  2値
                </button>
                <button
                  className={`btn ${shadingSteps === 3 ? 'btn-primary' : ''}`}
                  onClick={() => setShadingSteps(3)}
                >
                  3値
                </button>
                <button
                  className={`btn ${shadingSteps === 0 ? 'btn-primary' : ''}`}
                  onClick={() => setShadingSteps(0)}
                >
                  連続
                </button>
              </div>
            </div>
          </>
        )}
      </div>

      <div className="toolbar">
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
          <span>保存</span>
          <button className="btn btn-primary" onClick={handleSave} disabled={phase !== 'drawing' || saving}>
            保存
          </button>
        </div>
      </div>

      {phase === 'result' && evalResult && (
        <div className="result-overlay" onClick={handleNextPrompt}>
          <div className="result-modal" onClick={(e) => e.stopPropagation()}>
            <h2>評価結果</h2>
            <EvaluationView
              result={evalResult}
              stability={evalStability}
              image={evalImage}
              feedback={llmFeedback}
              feedbackLoading={feedbackLoading}
            />
            <div className="button-row">
              <button className="btn btn-primary" onClick={handleNextPrompt}>
                次のお題へ
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
