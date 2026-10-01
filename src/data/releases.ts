// Home rails derived from the catalog: real airing schedule and trending order when the
// catalog comes from AniList, sensible fallbacks for the offline demo series.
import type { Kind } from '@/theme/tokens';

import { animeSeries, manhwaSeries, type Series } from './catalog';

export type Release = {
  key: string;
  kind: Kind;
  series: Series;
  href: `/watch/${string}` | `/read/${string}` | `/anime/${string}` | `/manhwa/${string}`;
  label: string;
  when: string;
  /** Short highlight on the art ("Aujourd’hui", "Nouveau"). */
  tag?: string;
};

const byTrend = (a: Series, b: Series) => (a.trendRank ?? 99) - (b.trendRank ?? 99);

function airingLabel(airingAt: number) {
  const d = new Date(airingAt * 1000);
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  const days = Math.floor((d.getTime() - new Date().setHours(0, 0, 0, 0)) / 86_400_000);
  if (days <= 0) return { when: `Aujourd’hui · ${time}`, tag: 'Aujourd’hui' };
  if (days === 1) return { when: `Demain · ${time}`, tag: undefined };
  const day = d.toLocaleDateString('fr-FR', { weekday: 'short' }).replace('.', '');
  return { when: `${day} · ${time}`, tag: undefined };
}

/** Upcoming episodes, soonest first (falls back to latest episodes offline). */
export function animeReleases(): Release[] {
  const list = animeSeries();
  const airing = list.filter((s) => s.nextAiring).sort((a, b) => a.nextAiring!.airingAt - b.nextAiring!.airingAt);
  if (airing.length) {
    return airing.slice(0, 12).map((s) => {
      const { episode, airingAt } = s.nextAiring!;
      const latest = s.anime!.episodes[s.anime!.episodes.length - 1];
      const airing = airingLabel(airingAt);
      // The card plays the latest aired episode: say so, and date the upcoming one separately
      // (it used to read « Épisode 13 » and open episode 12).
      return latest
        ? {
            key: `${s.id}-next`,
            kind: 'anime',
            series: s,
            href: `/watch/${latest.id}`,
            label: `Ép. ${latest.number} dispo`,
            when: `Ép. ${episode} · ${airing.when}`,
            tag: airing.tag,
          }
        : { key: `${s.id}-next`, kind: 'anime', series: s, href: `/anime/${s.id}`, label: `Épisode ${episode}`, ...airing };
    });
  }
  return [...list].sort(byTrend).slice(0, 12).map((s, i) => {
    const eps = s.anime!.episodes;
    const ep = eps[eps.length - 1];
    return {
      key: ep.id, kind: 'anime', series: s, href: `/watch/${ep.id}`,
      label: `Épisode ${ep.number}`, when: s.status === 'completed' ? 'Terminé' : 'En cours', tag: i < 2 ? 'Nouveau' : undefined,
    };
  });
}

export function manhwaReleases(): Release[] {
  return [...manhwaSeries()].sort(byTrend).slice(0, 12).map((s, i) => {
    const chs = s.manhwa!.chapters;
    const ch = chs[chs.length - 1];
    return {
      key: ch.id,
      kind: 'manhwa',
      series: s,
      href: `/manhwa/${s.id}`,
      label: s.anime && s.estimated ? 'Suite de l’anime' : s.status === 'completed' ? 'Série terminée' : 'En cours',
      when: s.anime ? 'Aussi en anime' : `#${s.trendRank ?? i + 1} tendance`,
      tag: i === 0 ? 'Top' : undefined,
    };
  });
}

/** Weekly top: trending anime and manhwa interleaved. */
export function weeklyTop(): { series: Series; kind: Kind }[] {
  const a = [...animeSeries()].sort(byTrend).map((s) => ({ series: s, kind: 'anime' as Kind }));
  const m = [...manhwaSeries()].filter((s) => !s.anime).sort(byTrend).map((s) => ({ series: s, kind: 'manhwa' as Kind }));
  // Two anime, then one manhwa, repeated.
  const out: { series: Series; kind: Kind }[] = [];
  let ai = 0;
  let mi = 0;
  while (out.length < 10 && (ai < a.length || mi < m.length)) {
    if (ai < a.length) out.push(a[ai++]);
    if (ai < a.length) out.push(a[ai++]);
    if (mi < m.length) out.push(m[mi++]);
  }
  return out.slice(0, 10);
}
