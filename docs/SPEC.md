# AtelierLoop — イラスト練習ツール 実装仕様書

ブラウザ完結（フロントエンドのみ）のイラスト練習ツール。出題 → 描く → 測る → 振り返るのループを1画面で回す。
この文書は Claude Code への実装引き継ぎ用。フェーズ順に実装すること。

---

## 1. 全体方針

- **完全フロントエンド**。サーバー・APIキー不要。静的ホスティング（GitHub Pages / Cloudflare Pages）で配信可能なこと
- **LLM はコーチング専任、数値判断はアルゴリズム専任**。評価の信頼性は定量層が担保し、LLM（Gemma 4 E4B）は言語化・講評・出題のみ行う
- **ストロークはベクタデータが正、ラスタは派生物**。リプレイ・再評価・再レンダリングを可能にする
- LLM 未ロードでも描画・模写・3D出題（テンプレ出題）は全機能動作すること（グレースフルデグラデーション）

## 2. 技術スタック

| 領域 | 採用技術 | 備考 |
|---|---|---|
| ビルド | Vite + React + TypeScript | |
| 描画入力 | Pointer Events API | `pressure` / `tiltX` / `tiltY` / `getCoalescedEvents()` |
| 描画レンダリング | Canvas 2D（スタンプ方式ブラシ） | WebGL 化は P2 |
| 入力平滑化 | One Euro Filter | 自前実装（数十行） |
| 3D シーン | Three.js | プリミティブ生成・エッジ検出ポストプロセス |
| LLM | Gemma 4 E4B（onnx-community gemma-4-it-webgpu 系）+ Transformers.js + WebGPU | E2B フォールバック必須 |
| モデルキャッシュ | Cache API（Transformers.js 既定） | |
| 永続化 | IndexedDB（idb ライブラリ） | ストローク・セッション・成績・お題履歴 |
| 画像取込 | `<input type="file">` + `getUserMedia` | 射影変換は自前 or glfx 相当を自作 |

## 3. ディレクトリ構成（推奨）

```
src/
  app/                 # ルーティング・画面シェル
  drawing/             # 描画エンジン（フレームワーク非依存に保つ）
    engine.ts          # ストローク管理・スタンプレンダラ
    brush.ts           # 筆圧→線幅/不透明度カーブ
    oneEuro.ts
    replay.ts          # タイムラプス再生
  reference/           # 参照画像系
    capture.ts         # カメラ撮影・ファイル取込
    homography.ts      # 4点射影変換
    grid.ts            # グリッドオーバーレイ・セルフォーカス
  scene3d/             # プリミティブ・デッサンモード
    generator.ts       # シード付きシーン生成
    outline.ts         # 深度+法線 Sobel エッジ検出
    shading.ts         # トゥーン段階シェーディング・ライトプリセット
    groundTruth.ts     # 正解エッジマップ/深度の書き出し
  llm/
    runtime.ts         # モデルロード・E2B フォールバック・状態管理
    prompts.ts         # 出題/講評プロンプトテンプレ（JSON強制）
    schemas.ts         # zod による LLM 出力検証
  evaluation/
    quantitative.ts    # エッジ差分・重心ずれ・線の安定度
    rubric.ts          # 定量結果→LLM 入力サマリ整形
  progression/         # 継続系（ストリーク・再戦・弱点）
  store/               # IndexedDB ラッパ・型定義
```

## 4. データモデル（IndexedDB）

```ts
type Stroke = {
  points: { x: number; y: number; p: number; t: number }[]; // p=筆圧, t=ms
  brushId: string;
  color: string;
};

type Session = {
  id: string;
  promptId: string;
  strokes: Stroke[];          // ベクタが正
  thumbnailBlob: Blob;        // 一覧用ラスタ
  mode: 'free' | 'gridCopy' | 'primitive3d';
  startedAt: number;
  durationMs: number;
  evaluation?: Evaluation;
};

type Prompt = {
  id: string;
  source: 'llm' | 'template' | 'daily';
  text: string;
  category: Category;          // 'hand'|'perspective'|'animal'|'pose'|'still'|...
  constraints?: string[];      // '30秒'|'輪郭線禁止'|'左右反転' など
  scene3dSeed?: number;        // primitive3d のとき
  referenceImageId?: string;   // gridCopy のとき
};

type Evaluation = {
  quantitative: {
    cellScores?: number[][];      // グリッド模写: セル別エッジ差分スコア 0-1
    centroidOffsets?: [number, number][][];
    strokeStability: number;       // 速度分散ベース 0-1
    perspectiveErrors?: { edgeId: string; degrees: number }[]; // 3Dモード
  };
  llmFeedback?: { praise: string; issue: string; nextAction: string }; // 各1項目のみ
};

type UserStats = {
  streak: { current: number; best: number; lastDate: string };
  categoryScores: Record<Category, { ema: number; n: number }>; // 弱点ヒートマップ用
  xp: number;
};
```

## 5. 機能要件

### P0-1: 描画エンジン
- ペン/マウス/タッチで描画。`pointerType === 'pen'` 時は実筆圧、それ以外は速度疑似筆圧
- `getCoalescedEvents()` で全サンプル取得、One Euro Filter で平滑化（カットオフはUI調整可、既定 minCutoff=1.0, beta=0.007）
- 筆圧→線幅/不透明度のレスポンスカーブをユーザー編集可能（ベジェ1本で十分）
- Undo/Redo（ストローク単位）、レイヤーは「下絵/作画」の2枚固定で開始
- 受け入れ基準:
  - [ ] 筆圧 0.1 と 0.9 で線幅が明確に変化する
  - [ ] 素早いストロークでも点列が間引かれず滑らかに描ける
  - [ ] ストローク列から `replay.ts` で描画過程を任意速度で再生できる

### P0-2: グリッド模写
- ファイル取込 + カメラ撮影（`getUserMedia`）。撮影画像は4点ドラッグ指定→射影変換で台形補正
- 参照画像とキャンバスに同期グリッド（分割数 2〜8 可変）をオーバーレイ
- セルフォーカスモード: 1セルのみ拡大し参照/キャンバスを交互表示
- オニオンスキン（参照画像を透過下敷き、透過率スライダー）、左右反転チェック
- 受け入れ基準:
  - [ ] 斜めから撮影した紙の絵を矩形に補正して取り込める
  - [ ] グリッド分割数変更が参照・キャンバス両方に同期する

### P0-3: プリミティブ・デッサンモード（3D）
- シード付き乱数で Box/Sphere/Cylinder/Cone/Torus を 1〜5 個配置。シードから完全再現可能なこと
- 難易度: ①単体 ②複数 ③相互貫入 ④頂点ノイズ変形（④は P1）
- カメラ乱数化（FOV 20〜80°、アングル、距離）
- レンダリングモード切替:
  - **線画**: 深度+法線バッファの Sobel ポストプロセスで輪郭+稜線。線の太さ/閾値調整可
  - **陰影**: ライトプリセット（1灯キー / 3点）+ トゥーンシェーダで 2値/3値/連続を切替
  - **ワイヤーフレーム**: EdgesGeometry、透視表示
- 描く前は OrbitControls で回転確認可 → 「描き始める」でビュー固定
- 正解データ書き出し: 固定ビューのエッジマップ・深度バッファを評価用に保持
- 受け入れ基準:
  - [ ] 同一シードで同一シーン・同一カメラが再現される
  - [ ] 線画モードで輪郭線と面の境界線（貫入交差線含む）が出る
  - [ ] 3値シェーディングで影の境界が明確な段になる

### P0-4: 定量評価
- グリッド模写: 参照とユーザー絵を同グリッドで分割し、セルごとにエッジマップ（Sobel/Canny 簡易版）の差分と重心ずれをスコア化
- 3Dモード: 正解エッジマップとの比較。直線エッジは Hough 変換で角度比較し「パースが◯°ずれ」を算出（P1 でも可、最低限エッジ差分は P0）
- 全モード共通: ストローク速度分散から線の安定度を算出
- 結果はヒートマップ（セル色分け）で可視化
- 受け入れ基準:
  - [ ] 参照画像をそのままトレースした場合に高スコア、白紙で低スコアになる
  - [ ] セル別スコアがキャンバス上にオーバーレイ表示される

### P1-1: LLM 統合（Gemma 4 E4B）
- Transformers.js + WebGPU でロード。進捗バー表示、Cache API で2回目以降は即時
- デバイスメモリ判定（`navigator.deviceMemory` 等）で 8GB 未満は E2B を提案
- **出題**: JSON 強制出力 `{ motif, constraints[], category, difficulty }`。zod で検証、パース失敗時は1回リトライ→テンプレ出題にフォールバック
  - 過去成績（categoryScores）をプロンプトに注入し弱点カテゴリを重点出題
- **3Dアタリ出題**: レンダリング画像 + シーンのテキスト記述（プリミティブ種別・個数・カメラ角度）を併送し、「この構図を◯◯に見立てて描く」お題を生成。テキスト併記は E4B の視覚理解の不安定さを補う必須要件
- **講評**: 完成画像 + 定量評価サマリ（テキスト）を入力し、`{ praise, issue, nextAction }` を各1項目のみ生成。数値・スコアを LLM に生成させないこと
- 受け入れ基準:
  - [ ] LLM 未ロード/非対応環境でもテンプレ出題で全フロー完走できる
  - [ ] 不正 JSON 出力時にクラッシュせずフォールバックする

### P1-2: 継続の仕組み
- デイリーシード: 日付から決定論的に生成した 3D お題（全ユーザー共通）。1日1回、最小単位「ジェスチャー3枚 or デイリー1枚」
- ストリーク表示（現在/最高）。途切れ猶予なしのシンプル仕様で開始
- タイムラプスリプレイ: セッション一覧から再生、倍速切替
- 再戦システム: 30日前のお題を再出題し、当時の絵と並べて表示
- 弱点ヒートマップ: カテゴリ別 EMA スコアのレーダーチャート。低スコアカテゴリを出題で優先
- 受け入れ基準:
  - [ ] 同日中はデイリーお題が変わらない
  - [ ] 再戦時に新旧の絵が左右比較表示される

### P2（設計だけ考慮、実装しない）
- WebGL ブラシレンダラ、レイヤー多層化
- 頂点ノイズによる有機形状プリミティブ
- シード共有 URL（`?seed=` で同一お題に挑戦）
- 描画過程（リプレイ）自体の LLM 講評

## 6. 非ゴール

- アカウント・クラウド同期・SNS 共有（ローカル完結。エクスポートは画像保存のみ）
- 本格ペイントソフト機能（混色、テクスチャブラシ、多レイヤー合成）
- LLM による数値採点（定量はアルゴリズムのみ。理由: E4B の視覚評価は再現性が不足）
- iOS Safari の WebGPU フル対応（描画系は動作させるが LLM は非対応表示でよい)

## 7. 実装フェーズ

1. **Phase 1**: P0-1 描画エンジン + 永続化基盤 + リプレイ
2. **Phase 2**: P0-3 3Dモード（シーン生成→線画→陰影→正解データ書き出し）
3. **Phase 3**: P0-2 グリッド模写 + P0-4 定量評価
4. **Phase 4**: P1-1 LLM 統合（runtime → 出題 → アタリ出題 → 講評の順）
5. **Phase 5**: P1-2 継続系 + UI 仕上げ

LLM を最後にする理由: 描画/3D/評価は枯れた技術でリスクが低く、LLM 層は全機能のオプショナルな上掛けとして設計してあるため。

## 8. リスクと対策

| リスク | 対策 |
|---|---|
| E4B 初回 DL が数 GB・起動数十秒 | ロード前から全機能利用可。バックグラウンドロード + 進捗表示 |
| E4B の視覚理解が不安定 | 画像にシーンのテキスト記述を必ず併送。数値判断は渡さない |
| LLM の JSON 出力崩れ | zod 検証 + 1リトライ + テンプレフォールバック |
| Windows の WebGPU が遅い | E2B 切替 UI を常設。生成は非同期でブロックしない |
| ポインタイベントの筆圧がデバイス依存 | 疑似筆圧（速度ベース）を常備。設定で強制切替可 |
| IndexedDB 容量（ストローク肥大） | 点列を Float32Array でパック保存。サムネイルは縮小 Blob |

## 9. 未解決事項（実装中に判断）

- One Euro Filter のパラメータ既定値（実機ペンタブで調整）
- 3D 線画の Sobel 閾値とアンチエイリアス品質（FXAA を後段に入れるか）
- 講評プロンプトの口調・厳しさ（ユーザー設定にするか固定か）
