// リプレイモーダル: セッションをReplayPlayerで再生する
import { useEffect, useRef, useState } from 'react';
import { ReplayPlayer } from '../drawing/replay';
import type { Session } from '../store/types';
import './ReplayModal.css';

const CANVAS_WIDTH = 800;
const CANVAS_HEIGHT = 600;
const SPEEDS = [0.5, 1, 2, 4, 8];

type Props = {
  loadSession: () => Promise<Session | undefined>;
  onClose: () => void;
};

export const ReplayModal = ({ loadSession, onClose }: Props) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const playerRef = useRef<ReplayPlayer | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    let cancelled = false;

    void loadSession().then((session) => {
      if (cancelled) return;
      if (!session) {
        setError('セッションを読み込めませんでした');
        setLoading(false);
        return;
      }

      const canvas = canvasRef.current;
      if (!canvas) return;

      const items = session.strokes.map((stroke) => ({
        layer: 'sketch' as const,
        stroke,
      }));
      // ストロークは下絵/作画混在の保存順だが、layer情報は保存していないためsketchとして再生する
      const player = new ReplayPlayer(canvas, items, { width: CANVAS_WIDTH, height: CANVAS_HEIGHT });
      player.onProgress = (p) => setProgress(p);
      player.onEnd = () => setPlaying(false);
      playerRef.current = player;
      setLoading(false);
    });

    return () => {
      cancelled = true;
      playerRef.current?.destroy();
      playerRef.current = null;
    };
  }, [loadSession]);

  const handlePlayPause = () => {
    const player = playerRef.current;
    if (!player) return;
    if (playing) {
      player.pause();
      setPlaying(false);
    } else {
      player.play();
      setPlaying(true);
    }
  };

  const handleSpeedChange = (s: number) => {
    setSpeed(s);
    playerRef.current?.setSpeed(s);
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = Number(e.target.value) / 1000;
    playerRef.current?.seek(value);
    setProgress(value);
    setPlaying(false);
  };

  const handleClose = () => {
    playerRef.current?.destroy();
    playerRef.current = null;
    onClose();
  };

  return (
    <div className="replay-overlay" onClick={handleClose}>
      <div className="replay-modal" onClick={(e) => e.stopPropagation()}>
        <div className="replay-header">
          <h2>リプレイ</h2>
          <button className="btn" onClick={handleClose}>
            閉じる
          </button>
        </div>

        {loading && <p>読み込み中...</p>}
        {error && <p className="replay-error">{error}</p>}

        <div className="replay-canvas-wrap" style={{ display: loading || error ? 'none' : undefined }}>
          <canvas ref={canvasRef} className="replay-canvas" />
        </div>

        {!loading && !error && (
          <div className="replay-controls">
            <button className="btn btn-primary" onClick={handlePlayPause}>
              {playing ? '一時停止' : '再生'}
            </button>

            <div className="replay-speeds">
              {SPEEDS.map((s) => (
                <button
                  key={s}
                  className={`btn ${speed === s ? 'btn-primary' : ''}`}
                  onClick={() => handleSpeedChange(s)}
                >
                  {s}x
                </button>
              ))}
            </div>

            <input
              className="replay-seek"
              type="range"
              min={0}
              max={1000}
              step={1}
              value={Math.round(progress * 1000)}
              onChange={handleSeek}
            />
          </div>
        )}
      </div>
    </div>
  );
};
