// IndexedDB 永続化層（idb ラッパ）。docs/SPEC.md §4 データモデル / §8 IndexedDB容量対策に対応。
// 公開APIの入出力はアンパック済みの Session 等を用い、呼び出し側はパック処理を意識しない。

import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import type { Category, Prompt, Session, UserStats } from './types';
import { packStrokes, unpackStrokes, type StrokeMeta } from './packing';

const DB_NAME = 'atelierloop';
const DB_VERSION = 1;

/** userStats レコードの固定キー */
const USER_STATS_KEY = 'singleton';

/** IndexedDB 上の Session 保存形式。strokes はパック済み（meta + ArrayBuffer） */
type StoredSession = {
  id: string;
  promptId: string;
  strokesMeta: StrokeMeta[];
  strokesBuffer: ArrayBuffer;
  thumbnailBlob: Blob;
  mode: Session['mode'];
  startedAt: number;
  durationMs: number;
  evaluation?: Session['evaluation'];
};

/** sessions ストアの一覧表示用サマリ（strokesは展開しない） */
export type SessionSummary = {
  id: string;
  promptId: string;
  mode: Session['mode'];
  startedAt: number;
  durationMs: number;
  thumbnailBlob: Blob;
  hasEvaluation: boolean;
};

/** userStats の初期値（未保存時に返す） */
const INITIAL_USER_STATS: UserStats = {
  streak: { current: 0, best: 0, lastDate: '' },
  categoryScores: {} as Record<Category, { ema: number; n: number }>,
  xp: 0,
};

type ReferenceImageRecord = {
  id: string;
  blob: Blob;
  createdAt: number;
};

interface AtelierLoopDB extends DBSchema {
  sessions: {
    key: string;
    value: StoredSession;
    indexes: { startedAt: number; promptId: string };
  };
  prompts: {
    key: string;
    value: Prompt;
  };
  userStats: {
    key: string;
    value: UserStats;
  };
  referenceImages: {
    key: string;
    value: ReferenceImageRecord;
  };
}

let dbPromise: Promise<IDBPDatabase<AtelierLoopDB>> | undefined;

/** DBオープンの遅延シングルトン。実際にアクセスされたタイミングで初回オープンする */
function getDB(): Promise<IDBPDatabase<AtelierLoopDB>> {
  if (!dbPromise) {
    dbPromise = openDB<AtelierLoopDB>(DB_NAME, DB_VERSION, {
      upgrade(database) {
        const sessionStore = database.createObjectStore('sessions', { keyPath: 'id' });
        sessionStore.createIndex('startedAt', 'startedAt');
        sessionStore.createIndex('promptId', 'promptId');

        database.createObjectStore('prompts', { keyPath: 'id' });
        database.createObjectStore('userStats');
        database.createObjectStore('referenceImages', { keyPath: 'id' });
      },
    });
  }
  return dbPromise;
}

/** Session をパック済み形式に変換して保存する */
export async function saveSession(session: Session): Promise<void> {
  const db = await getDB();
  const { meta, buffer } = packStrokes(session.strokes);

  const stored: StoredSession = {
    id: session.id,
    promptId: session.promptId,
    strokesMeta: meta,
    strokesBuffer: buffer,
    thumbnailBlob: session.thumbnailBlob,
    mode: session.mode,
    startedAt: session.startedAt,
    durationMs: session.durationMs,
    evaluation: session.evaluation,
  };

  await db.put('sessions', stored);
}

/** 保存済みセッションをアンパックして取得する */
export async function getSession(id: string): Promise<Session | undefined> {
  const db = await getDB();
  const stored = await db.get('sessions', id);
  if (!stored) return undefined;

  return {
    id: stored.id,
    promptId: stored.promptId,
    strokes: unpackStrokes(stored.strokesMeta, stored.strokesBuffer),
    thumbnailBlob: stored.thumbnailBlob,
    mode: stored.mode,
    startedAt: stored.startedAt,
    durationMs: stored.durationMs,
    evaluation: stored.evaluation,
  };
}

/** セッション一覧用サマリを startedAt 降順で返す（strokesは展開しない） */
export async function listSessionSummaries(): Promise<SessionSummary[]> {
  const db = await getDB();
  const all = await db.getAllFromIndex('sessions', 'startedAt');

  return all
    .map((stored) => ({
      id: stored.id,
      promptId: stored.promptId,
      mode: stored.mode,
      startedAt: stored.startedAt,
      durationMs: stored.durationMs,
      thumbnailBlob: stored.thumbnailBlob,
      hasEvaluation: stored.evaluation !== undefined,
    }))
    .sort((a, b) => b.startedAt - a.startedAt);
}

/** セッションを削除する */
export async function deleteSession(id: string): Promise<void> {
  const db = await getDB();
  await db.delete('sessions', id);
}

/** お題を保存する */
export async function savePrompt(p: Prompt): Promise<void> {
  const db = await getDB();
  await db.put('prompts', p);
}

/** お題を取得する */
export async function getPrompt(id: string): Promise<Prompt | undefined> {
  const db = await getDB();
  return db.get('prompts', id);
}

/** ユーザー成績を取得する。未保存時は初期値を返す */
export async function getUserStats(): Promise<UserStats> {
  const db = await getDB();
  const stats = await db.get('userStats', USER_STATS_KEY);
  return stats ?? INITIAL_USER_STATS;
}

/** ユーザー成績を保存する */
export async function saveUserStats(s: UserStats): Promise<void> {
  const db = await getDB();
  await db.put('userStats', s, USER_STATS_KEY);
}

/** 参照画像（Blob）を保存する */
export async function saveReferenceImage(id: string, blob: Blob): Promise<void> {
  const db = await getDB();
  await db.put('referenceImages', { id, blob, createdAt: Date.now() });
}

/** 参照画像（Blob）を取得する */
export async function getReferenceImage(id: string): Promise<Blob | undefined> {
  const db = await getDB();
  const record = await db.get('referenceImages', id);
  return record?.blob;
}
