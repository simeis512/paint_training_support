// 出題/3Dアタリ出題/講評のプロンプトテンプレ（日本語・JSON強制）。React 非依存。
// SPEC §5 P1-1 / §8: 画像には必ずシーンのテキスト記述を併記する。

import type { UserStats, Category } from '../store/types.ts';
import type { SceneSpec, PrimitiveKind } from '../scene3d/generator.ts';
import type { ChatMessage } from './messages.ts';

// システム前置き（デッサンコーチ、簡潔・前向き・具体的、日本語）。
const SYSTEM_COACH: ChatMessage = {
  role: 'system',
  content:
    'あなたは経験豊富なデッサン・イラストのコーチです。' +
    '常に日本語で、簡潔・前向き・具体的に助言します。' +
    '数値やスコアは自分で判断・生成せず、与えられた定量情報のみを根拠にします。' +
    '指示された場合は、余計な説明を付けず有効な JSON のみを出力します。',
};

// カテゴリの日本語ラベル（プロンプト注入用）。
const CATEGORY_LABEL: Record<Category, string> = {
  hand: '手',
  perspective: 'パース・遠近',
  animal: '動物',
  pose: 'ポーズ・人体',
  still: '静物',
  gesture: 'ジェスチャー',
  other: 'その他',
};

/** categoryScores から ema の低い順（=弱点）に上位 n カテゴリを返す。 */
export function weakestCategories(stats: UserStats, n: number): Category[] {
  const entries = Object.entries(stats.categoryScores) as [Category, { ema: number; n: number }][];
  entries.sort((a, b) => a[1].ema - b[1].ema);
  return entries.slice(0, n).map(([cat]) => cat);
}

/** 出題プロンプト。弱点カテゴリを重点出題させる。 */
export function buildPromptGenMessages(stats: UserStats): ChatMessage[] {
  const weak = weakestCategories(stats, 2);
  const weakLabels = weak.map((c) => `${CATEGORY_LABEL[c]}(${c})`).join('、');

  const user =
    'イラスト練習のお題を1つ考えてください。\n' +
    `学習者の弱点カテゴリは ${weakLabels} です。これらを重点的に鍛えられるお題にしてください。\n` +
    '次のキーを持つ JSON のみを出力してください（他の文章は一切不要）:\n' +
    '- motif: 描く対象（日本語の短い語句）\n' +
    '- constraints: 制約の配列（0〜3個。例 "30秒で"、"輪郭線だけで"、"手首から先だけ"）\n' +
    `- category: 次のいずれか1つ ${categoryEnumHint()}\n` +
    '- difficulty: 難易度 1〜5 の整数\n' +
    '例: {"motif":"握った手","constraints":["30秒で"],"category":"hand","difficulty":2}';

  return [SYSTEM_COACH, { role: 'user', content: user }];
}

/** SceneSpec を人が読める日本語記述に変換（プリミティブ種別・個数・カメラ）。 */
export function describeScene(spec: SceneSpec): string {
  const kindLabel: Record<PrimitiveKind, string> = {
    box: '立方体',
    sphere: '球',
    cylinder: '円柱',
    cone: '円錐',
    torus: 'ドーナツ形（トーラス）',
  };

  // 種別ごとの個数を集計。
  const counts = new Map<PrimitiveKind, number>();
  for (const o of spec.objects) counts.set(o.kind, (counts.get(o.kind) ?? 0) + 1);
  const parts = [...counts.entries()].map(([k, n]) => `${kindLabel[k]}${n}個`);

  // カメラの高さ・方位・FOV を position/target から算出。
  const [px, py, pz] = spec.camera.position;
  const [tx, ty, tz] = spec.camera.target;
  const dx = px - tx;
  const dy = py - ty;
  const dz = pz - tz;
  const horiz = Math.hypot(dx, dz);
  const elevationDeg = (Math.atan2(dy, horiz) * 180) / Math.PI; // 見下ろし角
  const azimuthDeg = ((Math.atan2(dz, dx) * 180) / Math.PI + 360) % 360; // 方位

  const elevationText =
    elevationDeg > 25 ? '高い位置から見下ろす' : elevationDeg < 8 ? 'ほぼ水平の目線' : 'やや見下ろす';

  return (
    `構成: ${parts.join('、')}（合計${spec.objects.length}個）。難易度${spec.difficulty}。\n` +
    `カメラ: 画角(FOV) 約${spec.camera.fov.toFixed(0)}°、${elevationText}アングル` +
    `（見下ろし角 約${elevationDeg.toFixed(0)}°、方位 約${azimuthDeg.toFixed(0)}°）。`
  );
}

/** 3Dアタリ出題。シーン記述テキスト + 画像1枚を渡し「見立て」お題を JSON で出させる。 */
export function buildMitateMessages(spec: SceneSpec): ChatMessage[] {
  const sceneText = describeScene(spec);
  const user =
    'これは複数の基本立体を組み合わせた3D構図の画像です。\n' +
    `【シーンの説明】\n${sceneText}\n` +
    'この構図全体を「何か」に見立てて（例: ロボット、動物、乗り物、建物など）、' +
    'それをデッサンするお題を1つ作ってください。\n' +
    '次のキーを持つ JSON のみを出力してください（他の文章は一切不要）:\n' +
    '- motif: 見立ての内容（例 "座っているロボット"）\n' +
    '- constraints: 制約の配列（0〜3個）\n' +
    `- category: 次のいずれか1つ ${categoryEnumHint()}\n` +
    '- difficulty: 難易度 1〜5 の整数';

  return [
    SYSTEM_COACH,
    {
      role: 'user',
      content: [{ type: 'image' }, { type: 'text', text: user }],
    },
  ];
}

/** 講評。定量サマリテキスト + 完成画像を渡し {praise, issue, nextAction} を JSON で。 */
export function buildFeedbackMessages(summary: string): ChatMessage[] {
  const user =
    'これは学習者が描いた完成画像です。\n' +
    `【定量評価の要約（アルゴリズムが算出済み。数値はここに書かれたものが正）】\n${summary}\n` +
    '上記を踏まえ、講評してください。数値やスコアは自分で計算・生成しないでください。\n' +
    '次のキーを持つ JSON のみを出力してください（他の文章は一切不要）:\n' +
    '- praise: よかった点（1つだけ、簡潔に）\n' +
    '- issue: 課題（1つだけ、具体的に）\n' +
    '- nextAction: 次に試すべき具体的な練習（1つだけ）';

  return [
    SYSTEM_COACH,
    {
      role: 'user',
      content: [{ type: 'image' }, { type: 'text', text: user }],
    },
  ];
}

function categoryEnumHint(): string {
  return (Object.keys(CATEGORY_LABEL) as Category[]).join(' / ');
}
