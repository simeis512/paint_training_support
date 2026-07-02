// 画面シェル: ヘッダー + タブ切替（描く / セッション一覧）
import { useState } from 'react';
import { DrawScreen } from './DrawScreen';
import { GridCopyScreen } from './GridCopyScreen';
import { Scene3DScreen } from './Scene3DScreen';
import { SessionsScreen } from './SessionsScreen';
import { LlmPanel } from './LlmPanel';
import './App.css';

type Tab = 'draw' | 'gridCopy' | 'scene3d' | 'sessions';

function App() {
  const [tab, setTab] = useState<Tab>('draw');

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
        </nav>
        <LlmPanel />
      </header>

      <main className="app-main">
        {tab === 'draw' && <DrawScreen />}
        {tab === 'gridCopy' && <GridCopyScreen />}
        {tab === 'scene3d' && <Scene3DScreen />}
        {tab === 'sessions' && <SessionsScreen />}
      </main>
    </div>
  );
}

export default App;
