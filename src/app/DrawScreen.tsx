// 描画画面: キャンバス + ツールバー + 設定パネル
import { useCallback, useEffect, useRef, useState } from 'react';
import { DrawingEngine } from '../drawing/engine';
import { DEFAULT_BRUSH } from '../drawing/brush';
import { saveSession, savePrompt, getUserStats, saveUserStats, getSession } from '../store/db';
import { generateDrawingPrompt } from '../llm/services';
import { checkAndAdvanceStreak } from '../progression/streak';
import { xpForSession } from '../progression/xp';
import type { BrushConfig, LayerId, PressureCurve, Prompt, Session } from '../store/types';
import { PressureCurveEditor } from './PressureCurveEditor';
import { SESSION_SAVED_EVENT } from './StreakBadge';
import type { RematchContext } from './App';
import './DrawScreen.css';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

/** 初期手ブレ補正パラメータ（SPEC既定値） */
const DEFAULT_MIN_CUTOFF = 1.0;
const DEFAULT_BETA = 0.007;

type Props = {
  /** 再戦中のコンテキスト（mode==='free' のときのみ渡される） */
  rematch: RematchContext | null;
  onClearRematch: () => void;
};

export const DrawScreen = ({ rematch, onClearRematch }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<DrawingEngine | null>(null);
  // 描画開始時刻はエンジン生成エフェクト内で設定する（レンダー中にDate.now()を呼ばない）
  const startedAtRef = useRef<number>(0);

  // ブラシ設定全体（カーブエディタ含む）
  const [brush, setBrushState] = useState<BrushConfig>(DEFAULT_BRUSH);
  const [color, setColor] = useState('#f5f5f5');
  const [activeLayer, setActiveLayer] = useState<LayerId>('sketch');
  const [draftVisible, setDraftVisible] = useState(true);
  const [sketchVisible, setSketchVisible] = useState(true);
  const [draftOpacity, setDraftOpacity] = useState(1);

  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [curveTab, setCurveTab] = useState<'size' | 'opacity'>('size');
  const [minCutoff, setMinCutoff] = useState(DEFAULT_MIN_CUTOFF);
  const [beta, setBeta] = useState(DEFAULT_BETA);

  const [toast, setToast] = useState<string | null>(null);
  const [resetCounter, setResetCounter] = useState(0);

  // お題（初期表示はなし。「お題を出す」で生成）
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [promptLoading, setPromptLoading] = useState(false);

  // --- 再戦 ---
  const [rematchInfo, setRematchInfo] = useState<{ thumbUrl: string; ageDays: number | null } | null>(null);
  const [compareModal, setCompareModal] = useState<{ newThumbUrl: string } | null>(null);

  useEffect(() => {
    if (!rematch) return;
    let cancelled = false;
    const url = URL.createObjectURL(rematch.thumbnailBlob);
    void getSession(rematch.sessionId).then((s) => {
      if (cancelled) return;
      const ageDays = s ? Math.round((Date.now() - s.startedAt) / 86400000) : null;
      setRematchInfo({ thumbUrl: url, ageDays });
    });
    return () => {
      cancelled = true;
      setRematchInfo(null);
      URL.revokeObjectURL(url);
    };
  }, [rematch]);

  // エンジン生成・破棄
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const engine = new DrawingEngine(canvas, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
    engine.attachInput();
    engine.setBrush(brush);
    engine.setColor(color);
    engine.setActiveLayer(activeLayer);
    engine.setLayerVisible('draft', draftVisible);
    engine.setLayerVisible('sketch', sketchVisible);
    engine.setLayerOpacity('draft', draftOpacity);
    engine.setSmoothing(minCutoff, beta);
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
    // resetCounter が変わったときだけ再生成する（新規キャンバス用）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetCounter]);

  // ブラシ設定の変更をエンジンへ反映
  useEffect(() => {
    engineRef.current?.setBrush(brush);
  }, [brush]);

  useEffect(() => {
    engineRef.current?.setColor(color);
  }, [color]);

  useEffect(() => {
    engineRef.current?.setActiveLayer(activeLayer);
  }, [activeLayer]);

  useEffect(() => {
    engineRef.current?.setLayerVisible('draft', draftVisible);
  }, [draftVisible]);

  useEffect(() => {
    engineRef.current?.setLayerVisible('sketch', sketchVisible);
  }, [sketchVisible]);

  useEffect(() => {
    engineRef.current?.setLayerOpacity('draft', draftOpacity);
  }, [draftOpacity]);

  useEffect(() => {
    engineRef.current?.setSmoothing(minCutoff, beta);
  }, [minCutoff, beta]);

  const handleUndo = useCallback(() => {
    engineRef.current?.undo();
  }, []);

  const handleRedo = useCallback(() => {
    engineRef.current?.redo();
  }, []);

  const handleClearActiveLayer = useCallback(() => {
    engineRef.current?.clearLayer(activeLayer);
  }, [activeLayer]);

  const handleSizeCurveChange = useCallback((curve: PressureCurve) => {
    setBrushState((prev) => ({ ...prev, sizeCurve: curve }));
  }, []);

  const handleOpacityCurveChange = useCallback((curve: PressureCurve) => {
    setBrushState((prev) => ({ ...prev, opacityCurve: curve }));
  }, []);

  const handleGeneratePrompt = useCallback(async () => {
    setPromptLoading(true);
    try {
      const stats = await getUserStats();
      const { prompt: generated } = await generateDrawingPrompt(stats);
      await savePrompt(generated);
      setPrompt(generated);
      if (rematch) onClearRematch();
    } finally {
      setPromptLoading(false);
    }
  }, [rematch, onClearRematch]);

  const handleSave = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    const thumbnailBlob = await engine.exportImage(256);
    const strokes = engine.getStrokes().map((s) => s.stroke);

    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      promptId: prompt ? prompt.id : `free-${new Date(startedAtRef.current).toISOString().slice(0, 10)}`,
      strokes,
      thumbnailBlob,
      mode: 'free',
      startedAt: startedAtRef.current,
      durationMs: now - startedAtRef.current,
    };

    await saveSession(session);

    // XP加算（自由描画には定量評価がないため overall は null）
    const stats = await getUserStats();
    const xpGain = xpForSession(null, prompt?.source === 'daily');
    await saveUserStats({ ...stats, xp: stats.xp + xpGain });

    // ストリーク更新判定（結果は捨ててよい。イベントでヘッダーが再取得する）
    void checkAndAdvanceStreak();
    window.dispatchEvent(new CustomEvent(SESSION_SAVED_EVENT));

    setToast('保存しました');
    setTimeout(() => setToast(null), 2500);

    // 再戦中なら新旧比較モーダルを表示
    if (rematch) {
      setCompareModal({ newThumbUrl: URL.createObjectURL(thumbnailBlob) });
    }

    // 新規キャンバス: エンジン再生成
    setCanUndo(false);
    setCanRedo(false);
    setPrompt(null);
    setResetCounter((c) => c + 1);
  }, [prompt, rematch]);

  const handleCloseCompare = useCallback(() => {
    if (compareModal) URL.revokeObjectURL(compareModal.newThumbUrl);
    setCompareModal(null);
    onClearRematch();
  }, [compareModal, onClearRematch]);

  return (
    <div className="draw-screen">
      {rematchInfo && (
        <div className="rematch-panel">
          <img src={rematchInfo.thumbUrl} alt="前回の絵" className="rematch-panel-thumb" />
          <span className="rematch-panel-label">
            前回の絵{rematchInfo.ageDays !== null ? `（${rematchInfo.ageDays}日前）` : ''}
          </span>
        </div>
      )}

      <div className="prompt-panel">
        {prompt ? (
          <div className="prompt-content">
            <div className="prompt-main">
              <span className="prompt-motif">{prompt.text}</span>
              {prompt.source === 'llm' && <span className="prompt-badge">AI出題</span>}
            </div>
            <div className="prompt-meta">
              <span className="prompt-chip">{prompt.category}</span>
              {prompt.constraints?.map((c) => (
                <span key={c} className="prompt-chip">{c}</span>
              ))}
            </div>
          </div>
        ) : (
          <span className="prompt-placeholder">「お題を出す」を押すとお題が表示されます</span>
        )}
        <button
          className="btn btn-primary prompt-generate-btn"
          onClick={handleGeneratePrompt}
          disabled={promptLoading}
        >
          {promptLoading ? <span className="btn-spinner" /> : 'お題を出す'}
        </button>
      </div>

      <div className="canvas-wrap">
        <canvas ref={canvasRef} className="draw-canvas" />
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
          <span>レイヤー</span>
          <div className="button-row">
            <button
              className={`btn ${activeLayer === 'draft' ? 'btn-primary' : ''}`}
              onClick={() => setActiveLayer('draft')}
            >
              下絵
            </button>
            <button
              className={`btn ${activeLayer === 'sketch' ? 'btn-primary' : ''}`}
              onClick={() => setActiveLayer('sketch')}
            >
              作画
            </button>
          </div>
        </div>

        <div className="tool-item">
          <span>表示</span>
          <div className="button-row">
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={draftVisible}
                onChange={(e) => setDraftVisible(e.target.checked)}
              />
              下絵
            </label>
            <label className="checkbox-label">
              <input
                type="checkbox"
                checked={sketchVisible}
                onChange={(e) => setSketchVisible(e.target.checked)}
              />
              作画
            </label>
          </div>
        </div>

        <label className="tool-item">
          <span>下絵の不透明度: {Math.round(draftOpacity * 100)}%</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={draftOpacity}
            onChange={(e) => setDraftOpacity(Number(e.target.value))}
          />
        </label>

        <div className="tool-item">
          <span>クリア</span>
          <button className="btn btn-danger" onClick={handleClearActiveLayer}>
            アクティブレイヤーをクリア
          </button>
        </div>

        <div className="tool-item">
          <span>保存</span>
          <button className="btn btn-primary" onClick={handleSave}>
            保存
          </button>
        </div>
      </div>

      <details className="settings-panel" open={settingsOpen} onToggle={(e) => setSettingsOpen((e.target as HTMLDetailsElement).open)}>
        <summary>設定</summary>

        <div className="settings-content">
          <div className="settings-section">
            <h3>筆圧カーブ</h3>
            <div className="curve-tabs">
              <button
                className={`btn ${curveTab === 'size' ? 'btn-primary' : ''}`}
                onClick={() => setCurveTab('size')}
              >
                線幅
              </button>
              <button
                className={`btn ${curveTab === 'opacity' ? 'btn-primary' : ''}`}
                onClick={() => setCurveTab('opacity')}
              >
                不透明度
              </button>
            </div>
            {curveTab === 'size' ? (
              <PressureCurveEditor curve={brush.sizeCurve} onChange={handleSizeCurveChange} />
            ) : (
              <PressureCurveEditor curve={brush.opacityCurve} onChange={handleOpacityCurveChange} />
            )}
          </div>

          <div className="settings-section">
            <h3>手ブレ補正（One Euro Filter）</h3>
            <label className="tool-item">
              <span>minCutoff: {minCutoff.toFixed(3)}</span>
              <input
                type="range"
                min={0.1}
                max={5.0}
                step={0.01}
                value={minCutoff}
                onChange={(e) => setMinCutoff(Number(e.target.value))}
              />
            </label>
            <label className="tool-item">
              <span>beta: {beta.toFixed(4)}</span>
              <input
                type="range"
                min={0.001}
                max={0.05}
                step={0.001}
                value={beta}
                onChange={(e) => setBeta(Number(e.target.value))}
              />
            </label>
          </div>
        </div>
      </details>

      {compareModal && rematchInfo && (
        <div className="result-overlay" onClick={handleCloseCompare}>
          <div className="result-modal" onClick={(e) => e.stopPropagation()}>
            <h2>前回との比較</h2>
            <div className="rematch-compare">
              <div className="rematch-compare-pane">
                <span className="rematch-compare-label">
                  前回{rematchInfo.ageDays !== null ? `（${rematchInfo.ageDays}日前）` : ''}
                </span>
                <img src={rematchInfo.thumbUrl} alt="前回の絵" className="rematch-compare-img" />
              </div>
              <div className="rematch-compare-pane">
                <span className="rematch-compare-label">今回</span>
                <img src={compareModal.newThumbUrl} alt="今回の絵" className="rematch-compare-img" />
              </div>
            </div>
            <div className="button-row">
              <button className="btn btn-primary" onClick={handleCloseCompare}>
                閉じる
              </button>
            </div>
          </div>
        </div>
      )}

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
