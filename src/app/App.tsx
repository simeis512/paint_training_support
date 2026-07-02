// 画面シェル: ヘッダー + タブ切替（描く / グリッド模写 / 3Dデッサン / セッション一覧 / 成績）
import { useState } from 'react';
import { DrawScreen } from './DrawScreen';
import { GridCopyScreen } from './GridCopyScreen';
import { Scene3DScreen } from './Scene3DScreen';
import { SessionsScreen } from './SessionsScreen';
import { StatsScreen } from './StatsScreen';
import { LlmPanel } from './LlmPanel';
import { StreakBadge } from './StreakBadge';
import type { SessionMode } from '../store/types';
import './App.css';

type Tab = 'draw' | 'gridCopy' | 'scene3d' | 'sessions' | 'stats';

/** 再戦時に対象画面へ渡すコンテキスト。画面遷移後は各画面が読み込みに使う */
export type RematchContext = {
  sessionId: string;
  thumbnailBlob: Blob;
  mode: SessionMode;
  promptId: string;
};

function App() {
  const [tab, setTab] = useState<Tab>('draw');
  const [rematch, setRematch] = useState<RematchContext | null>(null);

  /** SessionsScreen からの再戦開始: 対象画面に切り替えてコンテキストを渡す */
  const handleStartRematch = (ctx: RematchContext) => {
    setRematch(ctx);
    const target: Record<SessionMode, Tab> = {
      primitive3d: 'scene3d',
      gridCopy: 'gridCopy',
      free: 'draw',
    };
    setTab(target[ctx.mode]);
  };

  /** 再戦を抜ける（別のお題を出す/新しい画像にする等、各画面から呼ばれる） */
  const handleClearRematch = () => setRematch(null);

  return (
    <div className="app">
      <header className="app-header">
        <h1 className="app-title">AtelierLoop</h1>
        <nav className="app-tabs">
          <button
            className={`app-tab ${tab === 'draw' ? 'active' : ''}`}
            onClick={() => setTab('draw')}
          >
            描く
          </button>
          <button
            className={`app-tab ${tab === 'gridCopy' ? 'active' : ''}`}
            onClick={() => setTab('gridCopy')}
          >
            グリッド模写
          </button>
          <button
            className={`app-tab ${tab === 'scene3d' ? 'active' : ''}`}
            onClick={() => setTab('scene3d')}
          >
            3Dデッサン
          </button>
          <button
            className={`app-tab ${tab === 'sessions' ? 'active' : ''}`}
            onClick={() => setTab('sessions')}
          >
            セッション一覧
          </button>
          <button
            className={`app-tab ${tab === 'stats' ? 'active' : ''}`}
            onClick={() => setTab('stats')}
          >
            成績
          </button>
        </nav>
        <div className="app-header-right">
          <StreakBadge />
          <LlmPanel />
        </div>
      </header>

      <main className="app-main">
        {tab === 'draw' && (
          <DrawScreen
            rematch={rematch?.mode === 'free' ? rematch : null}
            onClearRematch={handleClearRematch}
          />
        )}
        {tab === 'gridCopy' && (
          <GridCopyScreen
            rematch={rematch?.mode === 'gridCopy' ? rematch : null}
            onClearRematch={handleClearRematch}
          />
        )}
        {tab === 'scene3d' && (
          <Scene3DScreen
            rematch={rematch?.mode === 'primitive3d' ? rematch : null}
            onClearRematch={handleClearRematch}
          />
        )}
        {tab === 'sessions' && <SessionsScreen onStartRematch={handleStartRematch} />}
        {tab === 'stats' && <StatsScreen />}
      </main>
    </div>
  );
}

export default App;
