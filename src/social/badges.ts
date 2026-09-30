// Achievements: a pure function of the journal (PLAN §6). Computed on the *accepted*
// entries of the replay, so what the plausibility caps reject never earns a badge.
import type { JournalEntry } from '../p2p/contract';

import { DEFAULT_RULES, replayJournal, type RankRules } from './rank';

export type Badge = {
  id: string;
  title: string;
  description: string;
  /** Ionicons glyph name. */
  icon: string;
  earned: boolean;
  /** Timestamp of the entry that unlocked it. */
  earnedAt?: number;
  /** 0..1 */
  progress: number;
};

type Def = { id: string; title: string; description: string; icon: string; goal: number };

const DEFS: Def[] = [
  { id: 'first-ep', title: 'Premier épisode', description: 'Terminer un épisode.', icon: 'play-circle', goal: 1 },
  { id: 'first-ch', title: 'Premier chapitre', description: 'Terminer un chapitre.', icon: 'book', goal: 1 },
  { id: 'bridge', title: 'Passe-muraille', description: 'Voir l’anime puis lire le manhwa d’une même œuvre.', icon: 'swap-horizontal', goal: 1 },
  { id: 'binge', title: 'Marathon', description: '6 épisodes dans la même journée.', icon: 'flame', goal: 6 },
  { id: 'streak-7', title: 'Assidu', description: '7 jours d’activité d’affilée.', icon: 'calendar', goal: 7 },
  { id: 'talk-10', title: 'Bavard', description: '10 commentaires publiés.', icon: 'chatbubbles', goal: 10 },
  { id: 'explorer', title: 'Explorateur', description: 'Suivre 5 œuvres différentes.', icon: 'compass', goal: 5 },
  { id: 'reader-50', title: 'Rat de bibliothèque', description: '50 chapitres lus.', icon: 'library', goal: 50 },
  { id: 'eps-100', title: 'Centurion', description: '100 épisodes vus.', icon: 'trophy', goal: 100 },
];

export const BADGE_IDS = DEFS.map((d) => d.id);

export function badges(journal: JournalEntry[], rules: RankRules = DEFAULT_RULES): Badge[] {
  const { accepted } = replayJournal(journal, rules);
  const count = new Map<string, number>();
  const at = new Map<string, number>();
  const bump = (id: string, ts: number, value?: number) => {
    const v = value ?? (count.get(id) ?? 0) + 1;
    if (v > (count.get(id) ?? 0)) count.set(id, v);
    const def = DEFS.find((d) => d.id === id)!;
    if (!at.has(id) && v >= def.goal) at.set(id, ts);
  };

  const eps = new Set<string>();
  const chs = new Set<string>();
  const works = new Set<string>();
  const epsPerDay = new Map<number, number>();
  let lastDay = -Infinity;
  let run = 0;

  for (const { entry: e, day } of accepted) {
    if (day > lastDay) {
      run = day === lastDay + 1 ? run + 1 : 1;
      lastDay = day;
    }
    bump('streak-7', e.ts, run);
    if (e.type === 'comment') {
      bump('talk-10', e.ts);
      continue;
    }
    works.add(e.work);
    bump('explorer', e.ts, works.size);
    if (e.type === 'ep') {
      eps.add(e.work);
      bump('first-ep', e.ts);
      bump('eps-100', e.ts);
      const n = (epsPerDay.get(day) ?? 0) + 1;
      epsPerDay.set(day, n);
      bump('binge', e.ts, n);
      if (chs.has(e.work)) bump('bridge', e.ts, 1);
    } else {
      chs.add(e.work);
      bump('first-ch', e.ts);
      bump('reader-50', e.ts);
      if (eps.has(e.work)) bump('bridge', e.ts, 1);
    }
  }

  return DEFS.map((d) => {
    const v = count.get(d.id) ?? 0;
    return {
      id: d.id,
      title: d.title,
      description: d.description,
      icon: d.icon,
      earned: v >= d.goal,
      earnedAt: at.get(d.id),
      progress: Math.min(1, v / d.goal),
    };
  });
}
