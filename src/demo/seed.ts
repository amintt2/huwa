// Believable data for demo mode (store screenshots). Everything is fictional: the original
// DEMO_SERIES of data/catalog.ts, the demo peers of p2p/demo.ts and a local identity.
// Timestamps are relative to launch time so "2 h ago" / "yesterday" always read right.
import type { AiringItem } from '@/data/anilist-api';
import { DEMO_SERIES, getSeries } from '@/data/catalog';
import { DEMO_LABELERS, demoKeyOf } from '@/p2p/demo';
import { bytesToHex, deviceKeysFromSeed, fingerprint, phraseFromEntropy, rootKeysFromPhrase } from '@/social/identity';

import { demoLang } from './flags';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const en = demoLang === 'en';
const tr = (fr: string, english: string) => (en ? english : fr);

// ---------- identity ----------

const fixed = (salt: number) => Uint8Array.from({ length: 32 }, (_, i) => (i * 37 + salt * 11 + 7) & 0xff);
const PHRASE = phraseFromEntropy(fixed(1));
const ROOT = rootKeysFromPhrase(PHRASE);
const DEVICE = deviceKeysFromSeed(fixed(2));
const OTHER_DEVICE = deviceKeysFromSeed(fixed(3));

export const DEMO_ME = { name: 'nami.ink', key: ROOT.publicKey };

/** Values `p2p/secure` would return from the Keychain. */
export function demoSecrets(): Record<string, string> {
  return {
    'huwa.identity.phrase': PHRASE.join(' '),
    'huwa.identity.root': bytesToHex(ROOT.secretKey),
    'huwa.device.seed': bytesToHex(fixed(2)),
  };
}

// ---------- activity ----------

type Unit = { id: string; ts: number };

/** Chronological watching / reading history over the last ~6 weeks. */
function history(now: number) {
  const epQueue: string[] = [];
  const addEps = (sid: string, from: number, to: number) => {
    for (let n = from; n <= to; n++) epQueue.push(`${sid}-e${n}`);
  };
  addEps('sky', 1, 12);
  addEps('lotus', 1, 12);
  addEps('garden', 1, 13);
  addEps('void', 1, 11);
  addEps('tide', 1, 3);
  const chQueue: string[] = [];
  const addChs = (sid: string, from: number, to: number) => {
    for (let n = from; n <= to; n++) chQueue.push(`${sid}-c${n}`);
  };
  addChs('ledger', 1, 57);
  addChs('lotus', 1, 30);
  addChs('garden', 41, 46);

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const eps: Unit[] = [];
  const chs: Unit[] = [];
  const comments: { work: string; ts: number }[] = [];
  for (let d = 34; d >= 1; d--) {
    const day = today.getTime() - d * DAY;
    // Morning commute: a few chapters.
    const nCh = d % 5 === 0 ? 0 : 3;
    for (let i = 0; i < nCh && chQueue.length; i++) chs.push({ id: chQueue.shift()!, ts: day + 8 * HOUR + 10 * MIN + i * 7 * MIN });
    // Evening: one or two episodes, a marathon on one Saturday.
    const nEp = d === 20 ? 6 : d % 3 === 0 ? 1 : 2;
    for (let i = 0; i < nEp && epQueue.length; i++) eps.push({ id: epQueue.shift()!, ts: day + 20 * HOUR + i * 26 * MIN });
    if (d % 3 === 1) comments.push({ work: (eps[eps.length - 1] ?? chs[chs.length - 1]).id.split('-')[0], ts: day + 22 * HOUR + 30 * MIN });
  }
  return { eps, chs, comments };
}

export function demoStoreState(now = Date.now()) {
  const { eps, chs } = history(now);
  const episodes: Record<string, { position: number; duration: number; done: boolean; updatedAt: number }> = {};
  for (const e of eps) episodes[e.id] = { position: 1410, duration: 1410, done: true, updatedAt: e.ts };
  // Halfway through the latest episode: "Reprendre" on the home screen.
  episodes['void-e12'] = { position: 6 * 60 + 12, duration: 24 * 60, done: false, updatedAt: now - 2 * HOUR };
  const chapters: Record<string, { ratio: number; done: boolean; updatedAt: number }> = {};
  for (const c of chs) chapters[c.id] = { ratio: 1, done: true, updatedAt: c.ts };
  chapters['ledger-c58'] = { ratio: 0.42, done: false, updatedAt: now - 5 * HOUR };
  return {
    userName: DEMO_ME.name,
    episodes,
    chapters,
    myList: ['void', 'garden', 'ledger', 'tide', 'lotus'],
    comments: [],
    liked: {},
  };
}

export function demoLists(now = Date.now()) {
  return {
    lists: [
      { id: 'l-demo-weekend', name: tr('Ce week-end', 'This weekend'), seriesIds: ['tide', 'garden', 'sky'], createdAt: now - 12 * DAY },
      { id: 'l-demo-top', name: tr('Mes manhwa préférés', 'Favourite manhwa'), seriesIds: ['ledger', 'lotus', 'void'], createdAt: now - 30 * DAY },
      { id: 'l-demo-friends', name: tr('Conseillés par Mira', 'Mira’s picks'), seriesIds: ['garden', 'void'], createdAt: now - 6 * DAY },
    ],
    status: { void: 'watching', ledger: 'watching', garden: 'watching', sky: 'completed', lotus: 'completed', tide: 'planned' },
  };
}

export function demoSettings() {
  return {
    lang: demoLang,
    wifiOnly: false,
    quality: 'auto',
    subtitleSize: 'medium',
    notifications: false,
    notificationsAsked: true,
    onboarded: true,
  };
}

// ---------- P2P (local backend) ----------

export function demoP2PDB(now = Date.now()) {
  const { eps, chs, comments } = history(now);
  const me = DEMO_ME.key;
  const mira = demoKeyOf('mira.reads');
  const kaito = demoKeyOf('kaito_92');

  const journal = [
    ...eps.map((e) => ({ type: 'ep' as const, work: e.id.split('-')[0], unit: Number(e.id.split('-e')[1]), ts: e.ts })),
    ...chs.map((c) => ({ type: 'ch' as const, work: c.id.split('-')[0], unit: Number(c.id.split('-c')[1]), ts: c.ts })),
    ...comments.map((c) => ({ type: 'comment' as const, work: c.work, ts: c.ts })),
  ]
    .sort((a, b) => a.ts - b.ts)
    .map((e, i) => ({ e, prev: i ? `demo-${i - 1}` : '', hash: `demo-${i}`, sig: '' }));

  const mine = (id: string, target: string, text: string, ago: number, likes: number, timestamp?: number) => ({
    id: `demo-${id}`, target, author: me, authorName: DEMO_ME.name, text, createdAt: now - ago, likes, spoiler: false, timestamp,
  });

  const dm = (from: string, to: string, text: string, ago: number) => ({
    id: `dm-demo-${ago}`, from, to, text, createdAt: now - ago, delivered: true,
  });

  return {
    v: 1,
    profile: {
      key: me,
      name: DEMO_ME.name,
      bio: tr('Anime le soir, manhwa dans le métro.', 'Anime at night, manhwa on the train.'),
      createdAt: now - 62 * DAY,
      fingerprint: fingerprint(me),
    },
    devices: [
      { key: DEVICE.publicKey, name: tr('iPhone de Nami', 'Nami’s iPhone'), addedAt: now - 62 * DAY, current: true },
      { key: OTHER_DEVICE.publicKey, name: tr('iPad du salon', 'Living room iPad'), addedAt: now - 20 * DAY, current: false },
    ],
    phraseVerified: true,
    invites: [],
    comments: {
      void: [
        mine('v12', 'ep:void-e12', tr('La musique qui démarre à 12:47… frissons.', 'The track that kicks in at 12:47… chills.'), 3 * HOUR, 143, 767),
        mine('v11', 'ep:void-e11', tr('Le plan séquence à 20:34, le studio a tout donné.', 'That long take at 20:34, the studio went all in.'), 2 * DAY, 186, 1234),
      ],
      garden: [
        mine('g41', 'ch:garden-c41', tr('Si vous venez de l’anime : ce chapitre reprend pile après l’épisode 13.', 'Coming from the anime? This chapter picks up right after episode 13.'), 4 * DAY, 97),
      ],
    },
    likes: {},
    labels: [],
    follows: [mira, kaito, demoKeyOf('nox')],
    subscriptions: DEMO_LABELERS.map((l) => l.key),
    dms: {
      [mira]: [
        dm(mira, me, tr('Salut ! J’ai vu ton commentaire sur l’épisode 11 d’Echo of the Void. Tu lis aussi le manhwa ?', 'Hey! Saw your comment on Echo of the Void ep. 11. Do you read the manhwa too?'), 26 * HOUR),
        dm(me, mira, tr('Oui ! Et je viens d’attaquer Night Garden au chapitre 41, pile après l’anime.', 'Yes! And I just started Night Garden at chapter 41, right after the anime.'), 25 * HOUR),
        dm(mira, me, tr('Le meilleur moment. Le ch. 44 va te plaire 😄', 'Best part. You’re going to love ch. 44 😄'), 24 * HOUR),
        dm(me, mira, tr('Pas de spoiler hein !', 'No spoilers!'), 23 * HOUR),
        dm(mira, me, tr('Promis. On en reparle vendredi, après le nouvel épisode ?', 'Promise. Talk on Friday after the new episode?'), 40 * MIN),
      ],
      [kaito]: [
        dm(kaito, me, tr('Tidebreaker ép. 4 sort jeudi, tu regardes en même temps que moi ?', 'Tidebreaker ep. 4 drops Thursday, watch it with me?'), 5 * HOUR),
      ],
    },
    reads: { [mira]: now - 23 * HOUR, [kaito]: now - 6 * HOUR },
    peerNames: {},
    journal,
    migrated: true,
  };
}

// ---------- airing schedule (calendar) ----------

const EXTRA_AIRING: { title: string; color: string; weekday: number; time: [number, number]; episode: number }[] = [
  { title: 'Moonlit Forge', color: '#D9822B', weekday: 0, time: [16, 30], episode: 7 },
  { title: 'Hollow Crown', color: '#8A6CFF', weekday: 0, time: [22, 30], episode: 21 },
  { title: 'Paper Crane Club', color: '#E05A8A', weekday: 1, time: [18, 0], episode: 3 },
  { title: 'Starfall Academy', color: '#6C7BFF', weekday: 2, time: [17, 30], episode: 19 },
  { title: 'Ninth Lantern', color: '#E0B03A', weekday: 3, time: [23, 0], episode: 5 },
  { title: 'Salt & Circuit', color: '#3FB7A0', weekday: 4, time: [19, 30], episode: 11 },
  { title: 'Glass Harbor', color: '#5AA0E0', weekday: 5, time: [22, 0], episode: 8 },
  { title: 'Ember Road', color: '#E0603A', weekday: 6, time: [15, 0], episode: 2 },
];

/** A week of fictional airings: the demo series in "Ma liste" plus a few others. */
export function demoAiring(from: number, to: number): AiringItem[] {
  const start = new Date(from * 1000);
  start.setHours(0, 0, 0, 0);
  const at = (dayOffset: number, [h, m]: [number, number]) => Math.floor((start.getTime() + dayOffset * DAY + h * HOUR + m * MIN) / 1000);
  const items: AiringItem[] = [];
  const mineSchedule: { id: string; day: number; time: [number, number] }[] = [
    { id: 'tide', day: 1, time: [19, 0] },
    { id: 'lotus', day: 3, time: [20, 30] },
    { id: 'garden', day: 4, time: [22, 30] },
  ];
  mineSchedule.forEach(({ id, day, time }, i) => {
    const s = getSeries(id) ?? DEMO_SERIES.find((x) => x.id === id);
    if (!s?.anime) return;
    items.push({
      id: 990_000 + i, episode: s.anime.episodes.length + 1, airingAt: at(day, time), anilistId: 990_000 + i,
      title: s.title, color: s.palette[1], format: 'TV', seriesId: s.id,
    });
  });
  EXTRA_AIRING.forEach((x, i) => {
    items.push({ id: 991_000 + i, episode: x.episode, airingAt: at(x.weekday, x.time), anilistId: 991_000 + i, title: x.title, color: x.color, format: 'TV' });
  });
  return items.filter((a) => a.airingAt >= from && a.airingAt < to).sort((a, b) => a.airingAt - b.airingAt);
}
