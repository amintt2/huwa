// Watching/reading progress (src/store) → signed activity journal (rank, badges, history).
// Only transitions to `done` observed while an identity exists are appended; whatever was
// finished before the identity was created is imported once by the migration.
import { useEffect, useRef } from 'react';

import { parseUnitId } from '@/social/migrate';
import { useStore } from '@/store/store';

import { social } from './hooks';

type Done = Record<string, { done: boolean; updatedAt: number }>;
const doneIds = (m: Done) => new Set(Object.keys(m).filter((k) => m[k].done));

export function useJournalSync(enabled: boolean) {
  const episodes = useStore((s) => s.episodes);
  const chapters = useStore((s) => s.chapters);
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!enabled) {
      seen.current = null;
      return;
    }
    const now = new Set([...doneIds(episodes), ...doneIds(chapters)]);
    if (!seen.current) {
      seen.current = now;
      return;
    }
    for (const id of now) {
      if (seen.current.has(id)) continue;
      const u = parseUnitId(id);
      const p = episodes[id] ?? chapters[id];
      if (u && p) social.appendJournal({ type: u.type, work: u.work, unit: u.unit, ts: p.updatedAt }).catch(() => {});
    }
    seen.current = now;
  }, [enabled, episodes, chapters]);
}
