// ヘッダー右端の LLM 状態インジケータ + ポップオーバー。
// SPEC §8: E2B 切替 UI は常設。未ロードでも全機能利用できることを明示する。
import { useEffect, useRef, useState } from 'react';
import {
  subscribeLlm,
  loadLlm,
  isWebGpuAvailable,
  recommendedVariant,
  type LlmState,
  type LlmVariant,
} from '../llm/runtime';
import './LlmPanel.css';

const STATUS_LABEL: Record<LlmState['status'], string> = {
  idle: '未ロード',
  unsupported: '非対応',
  loading: 'ロード中',
  ready: '準備完了',
  error: 'エラー',
};

const VARIANT_OPTIONS: { value: LlmVariant; label: string; desc: string }[] = [
  { value: 'E4B', label: 'E4B', desc: '高品質・約4GB' },
  { value: 'E2B', label: 'E2B', desc: '軽量・約2GB' },
];

export const LlmPanel = () => {
  const [state, setState] = useState<LlmState | null>(null);
  const [open, setOpen] = useState(false);
  const [webGpuOk, setWebGpuOk] = useState<boolean | null>(null);
  // 推奨バリアントは同期関数なので遅延初期化で決定（effect 内 setState を避ける）
  const [variant, setVariant] = useState<LlmVariant>(() => recommendedVariant());
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => subscribeLlm(setState), []);

  // WebGPU 対応可否は非同期判定のため effect 内で取得
  useEffect(() => {
    void isWebGpuAvailable().then(setWebGpuOk);
  }, []);

  // ポップオーバー外クリックで閉じる
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!state) return null;

  const indicatorText =
    state.status === 'loading'
      ? `ロード中 ${Math.round(state.progress * 100)}%`
      : STATUS_LABEL[state.status];

  const handleLoad = () => {
    void loadLlm(variant);
  };

  return (
    <div className="llm-panel" ref={rootRef}>
      <button
        type="button"
        className={`llm-indicator llm-indicator-${state.status}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="llm-indicator-dot" />
        {indicatorText}
      </button>

      {open && (
        <div className="llm-popover">
          <div className="llm-popover-row">
            <span>WebGPU:</span>
            <span>{webGpuOk === null ? '判定中…' : webGpuOk ? '対応' : '非対応'}</span>
          </div>

          <div className="llm-popover-row llm-variant-select">
            <span>モデル選択:</span>
            <div className="llm-variant-options">
              {VARIANT_OPTIONS.map((opt) => (
                <label key={opt.value} className="llm-variant-option">
                  <input
                    type="radio"
                    name="llm-variant"
                    value={opt.value}
                    checked={variant === opt.value}
                    disabled={state.status === 'loading' || state.status === 'ready'}
                    onChange={() => setVariant(opt.value)}
                  />
                  <span>
                    {opt.label}（{opt.desc}）
                    {recommendedVariant() === opt.value && <span className="llm-recommended">推奨</span>}
                  </span>
                </label>
              ))}
            </div>
          </div>

          <button
            type="button"
            className="btn btn-primary llm-load-btn"
            onClick={handleLoad}
            disabled={state.status === 'loading' || state.status === 'ready' || webGpuOk === false}
          >
            {state.status === 'ready' ? 'ロード済み' : 'ロード開始'}
          </button>

          {state.status === 'loading' && (
            <div className="llm-progress-wrap">
              <div className="llm-progress-bar">
                <div className="llm-progress-fill" style={{ width: `${Math.round(state.progress * 100)}%` }} />
              </div>
              <span className="llm-progress-text">{state.progressText}</span>
            </div>
          )}

          {state.status === 'error' && state.error && (
            <div className="llm-error">エラー: {state.error}</div>
          )}

          {state.status === 'unsupported' && (
            <div className="llm-error">この環境は WebGPU に対応していません。</div>
          )}

          <p className="llm-popover-desc">
            LLMはお題生成と講評に使われます。未ロードでも全機能利用できます。
          </p>
        </div>
      )}
    </div>
  );
};
