// Deterministic demo comments so every episode/chapter has a living thread.
import type { Comment } from './store';

const AUTHORS = ['mira.reads', 'kaito_92', 'nox', 'sunny', 'haru.exe', 'lune', 'jin_ok', 'aria'];
const EP_LINES = [
  'L’animation de cette scène est folle, le studio s’est surpassé.',
  'Cette musique à la fin… j’ai remis l’épisode deux fois.',
  'Le rythme était un peu lent au début mais la fin rattrape tout.',
  'Le doublage VOSTFR est vraiment propre sur cet épisode.',
  'Quelqu’un a remarqué le détail dans le reflet ?',
];
const CH_LINES = [
  'Le retournement à la fin, je ne m’y attendais pas du tout.',
  'Les couleurs de ce chapitre sont superbes, surtout la double page.',
  'Vivement la semaine prochaine, je ne tiens plus.',
  'Le manhwa va tellement plus loin que l’anime sur ce passage.',
  'Ce dialogue entre les deux… parfait.',
];
const SPOILER = '[Commentaire de démo marqué spoiler — le texte réel des utilisateurs s’affichera ici.]';

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

const cache = new Map<string, Comment[]>();

export function seedComments(target: string): Comment[] {
  const hit = cache.get(target);
  if (hit) return hit;
  const isEp = target.startsWith('ep:');
  const lines = isEp ? EP_LINES : CH_LINES;
  const h = hash(target);
  const base = Date.now() - 3 * 86_400_000;
  const out: Comment[] = [];
  const n = 3 + (h % 3);
  for (let i = 0; i < n; i++) {
    const k = ((h >>> (i * 3)) + i) >>> 0;
    out.push({
      id: `s-${target}-${i}`,
      target,
      author: AUTHORS[k % AUTHORS.length],
      text: i === 2 ? SPOILER : lines[k % lines.length],
      spoiler: i === 2,
      createdAt: base + ((k * 7919) % (2.5 * 86_400_000)),
      likes: (k * 37) % 480,
      timestamp: isEp && i % 2 === 0 ? 60 + ((k * 13) % 700) : undefined,
      fromAnime: !isEp && i === 1,
    });
  }
  out.push({
    id: `s-${target}-r`,
    target,
    parentId: out[0].id,
    author: AUTHORS[(h + 3) % AUTHORS.length],
    text: isEp ? 'Pareil, j’ai eu des frissons.' : 'Pareil ! L’anime n’avait rien laissé paraître.',
    spoiler: false,
    createdAt: out[0].createdAt + 3_600_000,
    likes: 12 + (h % 50),
    fromAnime: !isEp,
  });
  cache.set(target, out);
  return out;
}
