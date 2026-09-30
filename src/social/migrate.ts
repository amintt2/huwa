// Pure migration of the pre-P2P local store (src/store/store.ts, `huwa/state/v1`) into the
// P2P model: comments get the new author key, likes are kept, finished episodes/chapters
// become journal entries. Shared by the `local` and `bare` implementations.
import type { JournalEntry, P2PComment } from '../p2p/contract';

export type LegacyComment = {
  id: string;
  target: string;
  parentId?: string;
  author: string;
  text: string;
  createdAt: number;
  likes: number;
  spoiler: boolean;
  timestamp?: number;
  fromAnime?: boolean;
};

export type LegacyState = {
  userName?: string;
  episodes?: Record<string, { done: boolean; updatedAt: number }>;
  chapters?: Record<string, { done: boolean; updatedAt: number }>;
  comments?: LegacyComment[];
  liked?: Record<string, true>;
};

/** `ep:12-e3` → `12`, `series:12` → `12` (same rule as `seriesIdOfTarget`). */
export const seriesOfTarget = (target: string) => (target.split(':')[1] ?? '').split('-')[0];

/** `12-e3` → { work: '12', type: 'ep', unit: 3 } */
export function parseUnitId(id: string): { work: string; type: 'ep' | 'ch'; unit: number } | undefined {
  const m = /^(.+)-([ec])(\d+)$/.exec(id);
  if (!m) return undefined;
  return { work: m[1], type: m[2] === 'e' ? 'ep' : 'ch', unit: Number(m[3]) };
}

export type Migrated = {
  comments: Omit<P2PComment, 'likedByMe'>[];
  likes: Record<string, true>;
  journal: JournalEntry[];
};

export function migrateLegacy(legacy: LegacyState, me: { key: string; name: string }): Migrated {
  const comments = (legacy.comments ?? []).map((c) => ({
    id: c.id,
    target: c.target,
    parentId: c.parentId,
    author: me.key,
    authorName: c.author || me.name,
    text: c.text,
    createdAt: c.createdAt,
    likes: c.likes ?? 0,
    spoiler: !!c.spoiler,
    timestamp: c.timestamp,
    fromAnime: c.fromAnime,
  }));

  const journal: JournalEntry[] = [];
  for (const [id, p] of [...Object.entries(legacy.episodes ?? {}), ...Object.entries(legacy.chapters ?? {})]) {
    if (!p?.done) continue;
    const u = parseUnitId(id);
    if (u) journal.push({ type: u.type, work: u.work, unit: u.unit, ts: p.updatedAt });
  }
  for (const c of legacy.comments ?? []) journal.push({ type: 'comment', work: seriesOfTarget(c.target), ts: c.createdAt });
  // The journal is hash-chained in declaration order: replay expects increasing timestamps.
  journal.sort((a, b) => a.ts - b.ts);

  return { comments, likes: { ...(legacy.liked ?? {}) }, journal };
}
