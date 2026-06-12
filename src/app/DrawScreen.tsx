// 描画画面: キャンバス + ツールバー + 設定パネル
import { useCallback, useEffect, useRef, useState } from 'react';
import { DrawingEngine } from '../drawing/engine';
import { DEFAULT_BRUSH } from '../drawing/brush';
import { saveSession } from '../store/db';
import type { BrushConfig, LayerId, PressureCurve, Session } from '../store/types';
import { PressureCurveEditor } from './PressureCurveEditor';
import './DrawScreen.css';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;

/** 初期手ブレ補正パラメータ（SPEC既定値） */
const DEFAULT_MIN_CUTOFF = 1.0;
const DEFAULT_BETA = 0.007;

export const DrawScreen = () => {
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

  const handleSave = useCallback(async () => {
    const engine = engineRef.current;
    if (!engine) return;

    const thumbnailBlob = await engine.exportImage(256);
    const strokes = engine.getStrokes().map((s) => s.stroke);

    const now = Date.now();
    const session: Session = {
      id: crypto.randomUUID(),
      promptId: `free-${new Date(startedAtRef.current).toISOString().slice(0, 10)}`,
      strokes,
      thumbnailBlob,
      mode: 'free',
      startedAt: startedAtRef.current,
      durationMs: now - startedAtRef.current,
    };

    await saveSession(session);
    setToast('保存しました');
    setTimeout(() => setToast(null), 2500);

    // 新規キャンバス: エンジン再生成
    setCanUndo(false);
    setCanRedo(false);
    setResetCounter((c) => c + 1);
  }, []);

  return (
    <div className="draw-screen">
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

      {toast && <div className="toast">{toast}</div>}
    </div>
  );
};
