// Demo peers for the `local` implementation: the seed comment authors get a stable key,
// a profile and a plausible journal so every social screen can be exercised offline.
// Nothing here is used by the `bare` implementation.
import { getSeries } from '@/data/catalog';
import { demoKey, fingerprint } from '@/social/identity';
import { seedComments } from '@/store/seed-comments';

import type { CommentFlag, JournalEntry, Label, MappingProposal, P2PComment, Profile } from './contract';

const BIOS: Record<string, string> = {
  'mira.reads': 'Je lis tout en webtoon, je regarde tout en VOSTFR.',
  kaito_92: 'Shōnen, seinen, et beaucoup trop de café.',
  nox: 'Théories à 3 h du matin.',
  sunny: 'Fan de romance et de tranches de vie.',
  'haru.exe': 'Animation nerd. Je note les sakuga.',
  lune: 'Manhwa d’abord, anime ensuite.',
  jin_ok: 'Arts martiaux, murim, cultivation.',
  aria: 'Je commente chaque chapitre, désolée d’avance.',
};

export const DEMO_NAMES = Object.keys(BIOS);
const SPAMMER = 'promo_hd_free';

export const DEMO_LABELERS = [
  { key: demoKey('labeler:antispam'), name: 'Veille anti-spam', description: 'Comptes publicitaires et arnaques signalés par des bénévoles.' },
  { key: demoKey('labeler:communaute'), name: 'Modération communautaire', description: 'Harcèlement et spoilers non marqués.' },
];

const byKey = new Map<string, string>([...DEMO_NAMES, SPAMMER, 'haters_only'].map((n) => [demoKey(n), n]));
export const isDemoKey = (key: string) => byKey.has(key) || DEMO_LABELERS.some((l) => l.key === key);

const BASE = Date.UTC(2025, 10, 1);

export function demoProfile(key: string): Profile | undefined {
  const labeler = DEMO_LABELERS.find((l) => l.key === key);
  if (labeler) return { key, name: labeler.name, bio: `${labeler.description} (liste de démonstration)`, createdAt: BASE, fingerprint: fingerprint(key) };
  const name = byKey.get(key);
  if (!name) return undefined;
  return {
    key,
    name,
    bio: `${BIOS[name] ?? (name === SPAMMER ? 'Compte promotionnel.' : 'Compte de démonstration.')} · Profil de démonstration`,
    createdAt: BASE - (name.length * 17 % 90) * 86_400_000,
    fingerprint: fingerprint(key),
  };
}

function hash(str: string) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Deterministic, plausible journal (a few episodes per evening, some chapters). */
export function demoJournal(key: string): JournalEntry[] {
  const name = byKey.get(key);
  if (!name || name === SPAMMER) return [];
  const h = hash(name);
  const out: JournalEntry[] = [];
  const days = 20 + (h % 60);
  for (let d = 0; d < days; d++) {
    if ((h >>> (d % 24)) & 1) continue;
    const start = BASE + d * 86_400_000 + 19 * 3_600_000;
    const eps = 1 + ((h + d) % 4);
    for (let i = 0; i < eps; i++) out.push({ type: 'ep', work: String(1 + ((h + d) % 5)), unit: d * 4 + i + 1, ts: start + i * 24 * 60_000 });
    if ((h + d) % 3 === 0) out.push({ type: 'ch', work: String(1 + (h % 5)), unit: d + 1, ts: start + 3 * 3_600_000 });
    if ((h + d) % 4 === 0) out.push({ type: 'comment', work: String(1 + (h % 5)), ts: start + 3 * 3_600_000 + 60_000 });
  }
  return out;
}

/** Both demo lists block the spammer → hidden by the "2 subscriptions" rule. */
export function demoLabels(labeler: string): Label[] {
  if (!DEMO_LABELERS.some((l) => l.key === labeler)) return [];
  return [{ by: labeler, target: demoKey(SPAMMER), val: 'spam', ts: BASE }];
}

const targetsCache = new Map<string, string[]>();
function targetsOf(seriesId: string): string[] {
  const hit = targetsCache.get(seriesId);
  if (hit) return hit;
  const s = getSeries(seriesId);
  const out = [
    `series:${seriesId}`,
    ...(s?.anime?.episodes ?? []).map((e) => `ep:${e.id}`),
    ...(s?.manhwa?.chapters ?? []).map((c) => `ch:${c.id}`),
  ];
  targetsCache.set(seriesId, out);
  return out;
}

const seriesCache = new Map<string, Omit<P2PComment, 'likedByMe'>[]>();

/** Seed thread of every episode/chapter of a work, plus one spam message on the series page. */
export function demoComments(seriesId: string): Omit<P2PComment, 'likedByMe'>[] {
  const hit = seriesCache.get(seriesId);
  if (hit) return hit;
  const out: Omit<P2PComment, 'likedByMe'>[] = [];
  for (const target of targetsOf(seriesId)) {
    if (target.startsWith('series:')) {
      out.push({
        id: `s-${target}-spam`, target, author: demoKey(SPAMMER), authorName: SPAMMER,
        text: 'Tous les épisodes en HD gratuit, lien dans ma bio !!!', createdAt: BASE, likes: 0, spoiler: false,
      });
      continue;
    }
    for (const c of seedComments(target)) {
      out.push({ ...c, author: demoKey(c.author), authorName: c.author });
    }
    out.push(...demoExtras(target));
  }
  seriesCache.set(seriesId, out);
  return out;
}

/** A GIF that exists on GIPHY's CDN (demo only). */
const DEMO_GIF = 'https://media.giphy.com/media/26ufdipQqU2lhNA4g/200.gif';
const TROLL = 'haters_only';

/**
 * Comments that show what the thread can do: a time range, Markdown, a GIF, inline anchors, a page
 * range — and one comment collapsed by community reports (see demoFlags).
 */
function demoExtras(target: string): Omit<P2PComment, 'likedByMe'>[] {
  const at = BASE + 40 * 86_400_000;
  const c = (i: number, author: string, text: string, extra: Partial<P2PComment> = {}): Omit<P2PComment, 'likedByMe'> => ({
    id: `s-${target}-x${i}`, target, author: demoKey(author), authorName: author, text, createdAt: at + i * 3_600_000,
    likes: [212, 87, 46, 9, 3][i] ?? 0, spoiler: false, ...extra,
  });
  if (target.startsWith('ep:')) {
    return [
      c(0, 'haru.exe', '12:47–13:05 Ce **plan-séquence** sous la pluie… *regardez les reflets dans les flaques*. ||Et le retour du maître à la fin !||', { timestamp: 767 }),
      c(1, 'sunny', 'Ma réaction à 18:20 :\n' + DEMO_GIF),
      c(2, 'nox', 'Mes moments préférés :\n- 3:12 l’ouverture\n- 8:40-9:15 le duel, ~~trop court~~ parfait\n> « On ne recule pas. »'),
      c(3, TROLL, 'Cet anime est nul et ceux qui le regardent aussi.'),
    ];
  }
  if (target.startsWith('ch:')) {
    return [
      c(0, 'lune', 'p. 12–14 La double page du combat est **incroyable**, et regardez le détail p. 3 en arrière-plan.'),
      c(1, 'jin_ok', 'p. 21 ce cadrage 😮\n' + DEMO_GIF),
      c(3, TROLL, 'Les lecteurs de ce manhwa sont tous des idiots.'),
    ];
  }
  return [];
}

/** Three demo regulars reported the troll comment of each thread: collapsed for everyone. */
export function demoFlags(seriesId: string): CommentFlag[] {
  const out: CommentFlag[] = [];
  for (const target of targetsOf(seriesId)) {
    if (target.startsWith('series:')) continue;
    const comment = `s-${target}-x3`;
    ['mira.reads', 'kaito_92', 'aria'].forEach((n, i) => out.push({ comment, author: demoKey(n), reason: 'abuse', ts: BASE + 41 * 86_400_000 + i }));
  }
  return out;
}

const REPLIES = [
  'Haha carrément ! Tu en es à quel épisode ?',
  'Je viens de finir le chapitre, je n’en reviens pas.',
  'On en reparle après le prochain épisode 😄',
  'Pas de spoiler hein !',
  'Merci pour le message, je te réponds dès que je peux.',
];

/** Canned answer from a demo peer (local test loop). */
export const demoReply = (peer: string, n: number) => (byKey.has(peer) ? REPLIES[(hash(peer) + n) % REPLIES.length] : undefined);

export const DEMO_WELCOME = { name: 'mira.reads', text: 'Salut ! J’ai vu ton commentaire sur le dernier chapitre, tu lis aussi le manhwa ?' };

export const demoKeyOf = (name: string) => demoKey(name);

/**
 * Corrections from demo peers: two of them agree that season 2 of "Echo of the Void"
 * (src/demo/seasons.ts) ends at chapter 88, so one more confirmation can verify it.
 */
export function demoMapping(room: string): MappingProposal[] {
  if (room !== 'void') return [];
  return [
    { season: 'void2', field: 'end', to: 88, author: demoKey('mira.reads'), ts: BASE + 3_600_000 },
    { season: 'void2', field: 'end', to: 88, author: demoKey('kaito_92'), ts: BASE + 7_200_000 },
  ];
}
