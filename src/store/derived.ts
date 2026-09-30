import { useMemo } from 'react';

import { chapterAfterEpisode, continuationChapter } from '@/data/bridge';
import { getChapter, getEpisode, type Series } from '@/data/catalog';
import type { Kind } from '@/theme/tokens';

import { seedComments } from './seed-comments';
import { useStore, type Comment } from './store';

export type ContinueItem = {
  key: string;
  kind: Kind;
  series: Series;
  /** Route to open. */
  href: `/watch/${string}` | `/read/${string}`;
  label: string;
  sub: string;
  progress: number;
  /** True when this item jumps to the other format (anime → manhwa). */
  bridged: boolean;
  updatedAt: number;
};

/** "Continuer" rail: the latest thing per series, across anime and manhwa. */
export function useContinueItems(): ContinueItem[] {
  const episodes = useStore((s) => s.episodes);
  const chapters = useStore((s) => s.chapters);

  return useMemo(() => {
    const latest = new Map<string, ContinueItem>();
    const offer = (item: ContinueItem) => {
      const prev = latest.get(item.series.id);
      if (!prev || prev.updatedAt < item.updatedAt) latest.set(item.series.id, item);
    };

    for (const [id, p] of Object.entries(episodes)) {
      const found = getEpisode(id);
      if (!found) continue;
      const { series, episode } = found;
      const eps = series.anime!.episodes;
      if (!p.done) {
        const left = Math.max(1, Math.round((p.duration - p.position) / 60));
        offer({
          key: id, kind: 'anime', series, href: `/watch/${id}`,
          label: `Ép. ${episode.number}`, sub: `reste ${left} min`,
          progress: p.position / p.duration, bridged: false, updatedAt: p.updatedAt,
        });
        continue;
      }
      const next = eps.find((e) => e.number === episode.number + 1);
      if (next && !episodes[next.id]) {
        offer({
          key: next.id, kind: 'anime', series, href: `/watch/${next.id}`,
          label: `Ép. ${next.number}`, sub: 'Épisode suivant', progress: 0, bridged: false, updatedAt: p.updatedAt,
        });
      } else if (!next) {
        // Anime finished → pick up the story in the manhwa.
        const ch = continuationChapter(series) ?? chapterAfterEpisode(series, episode);
        if (ch && !chapters[ch.id]) {
          offer({
            key: ch.id, kind: 'manhwa', series, href: `/read/${ch.id}`,
            label: `Ch. ${ch.number}`, sub: 'La suite de l’anime', progress: 0, bridged: true, updatedAt: p.updatedAt,
          });
        }
      }
    }

    for (const [id, p] of Object.entries(chapters)) {
      const found = getChapter(id);
      if (!found) continue;
      const { series, chapter } = found;
      const total = series.manhwa!.chapters.length;
      if (!p.done) {
        offer({
          key: id, kind: 'manhwa', series, href: `/read/${id}`,
          label: `Ch. ${chapter.number}`, sub: `${Math.round(p.ratio * 100)} % lu`,
          progress: p.ratio, bridged: false, updatedAt: p.updatedAt,
        });
      } else if (chapter.number < total) {
        const next = series.manhwa!.chapters[chapter.number];
        offer({
          key: next.id, kind: 'manhwa', series, href: `/read/${next.id}`,
          label: `Ch. ${next.number}`, sub: 'Chapitre suivant', progress: 0, bridged: false, updatedAt: p.updatedAt,
        });
      }
    }

    return [...latest.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }, [episodes, chapters]);
}

/** Seed + user comments for a target, with `liked` resolved. */
export function useThread(target: string) {
  const all = useStore((s) => s.comments);
  const liked = useStore((s) => s.liked);
  return useMemo(() => {
    const mine = all.filter((c) => c.target === target);
    const list: (Comment & { liked: boolean })[] = [...mine, ...seedComments(target)].map((c) => ({
      ...c,
      liked: !!liked[c.id],
      likes: c.likes + (liked[c.id] ? 1 : 0),
    }));
    return list;
  }, [all, liked, target]);
}
