// セッション一覧画面: サムネイルグリッド + リプレイモーダル
import { useCallback, useEffect, useState } from 'react';
import { deleteSession, getSession, listSessionSummaries, type SessionSummary } from '../store/db';
import { ReplayModal } from './ReplayModal';
import './SessionsScreen.css';

const formatDate = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`;
};

const formatDuration = (ms: number): string => {
  const totalSec = Math.round(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return min > 0 ? `${min}分${sec}秒` : `${sec}秒`;
};

export const SessionsScreen = () => {
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [replayId, setReplayId] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  // reloadToken が変わるたびに一覧を再取得する
  useEffect(() => {
    let cancelled = false;
    void listSessionSummaries().then((list) => {
      if (cancelled) return;
      setSessions(list);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [reloadToken]);

  const handleDelete = useCallback(async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (!window.confirm('このセッションを削除しますか？')) return;
    await deleteSession(id);
    setReloadToken((t) => t + 1);
  }, []);

  return (
    <div className="sessions-screen">
      {loading && <p className="sessions-empty">読み込み中...</p>}
      {!loading && sessions.length === 0 && <p className="sessions-empty">まだセッションがありません</p>}

      <div className="sessions-grid">
        {sessions.map((s) => (
          <div key={s.id} className="session-card" onClick={() => setReplayId(s.id)}>
            <img className="session-thumb" src={URL.createObjectURL(s.thumbnailBlob)} alt="" />
            {s.hasEvaluation && <span className="session-eval-badge">評価あり</span>}
            <div className="session-info">
              <span className="session-date">{formatDate(s.startedAt)}</span>
              <span className="session-duration">{formatDuration(s.durationMs)}</span>
            </div>
            <button className="btn btn-danger session-delete" onClick={(e) => handleDelete(s.id, e)}>
              削除
            </button>
          </div>
        ))}
      </div>

      {replayId && (
        <ReplayModal
          loadSession={() => getSession(replayId)}
          onClose={() => setReplayId(null)}
        />
      )}
    </div>
  );
};
