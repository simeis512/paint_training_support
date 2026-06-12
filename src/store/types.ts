// データモデル定義（docs/SPEC.md §4 が正）
// ここはサブモジュール間の共有契約。変更時は SPEC.md と整合させること。

export type StrokePoint = {
  x: number;
  y: number;
  /** 筆圧 0–1 */
  p: number;
  /** ストローク開始からの経過ミリ秒 */
  t: number;
};

export type Stroke = {
  points: StrokePoint[];
  brushId: string;
  color: string;
};

export type LayerId = 'sketch' | 'draft'; // sketch=作画, draft=下絵

export type Category =
  | 'hand'
  | 'perspective'
  | 'animal'
  | 'pose'
  | 'still'
  | 'gesture'
  | 'other';

export type SessionMode = 'free' | 'gridCopy' | 'primitive3d';

export type Evaluation = {
  quantitative: {
    cellScores?: number[][];
    centroidOffsets?: [number, number][][];
    /** 速度分散ベースの線の安定度 0–1 */
    strokeStability: number;
    perspectiveErrors?: { edgeId: string; degrees: number }[];
  };
  llmFeedback?: { praise: string; issue: string; nextAction: string };
};

export type Session = {
  id: string;
  promptId: string;
  /** ベクタデータが正。ラスタは派生物 */
  strokes: Stroke[];
  thumbnailBlob: Blob;
  mode: SessionMode;
  startedAt: number;
  durationMs: number;
  evaluation?: Evaluation;
};

export type Prompt = {
  id: string;
  source: 'llm' | 'template' | 'daily';
  text: string;
  category: Category;
  constraints?: string[];
  scene3dSeed?: number;
  referenceImageId?: string;
};

export type UserStats = {
  streak: { current: number; best: number; lastDate: string };
  categoryScores: Record<Category, { ema: number; n: number }>;
  xp: number;
};

/** 筆圧→線幅/不透明度のレスポンスカーブ（3次ベジェ1本、端点固定 (0,0)-(1,1)） */
export type PressureCurve = {
  /** 制御点1 (x1, y1), 制御点2 (x2, y2)。各 0–1 */
  cp1: [number, number];
  cp2: [number, number];
};

export type BrushConfig = {
  id: string;
  name: string;
  /** 最大線幅 px */
  size: number;
  /** 基本不透明度 0–1 */
  opacity: number;
  /** 筆圧→線幅カーブ */
  sizeCurve: PressureCurve;
  /** 筆圧→不透明度カーブ */
  opacityCurve: PressureCurve;
  /** スタンプ間隔（線幅に対する比率、例 0.15） */
  spacing: number;
  /** エッジのソフトネス 0(硬)–1(柔) */
  hardness: number;
};
