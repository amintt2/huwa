// Automatic linking of catalog series (AniList) to the user's installed sources: when a manhwa
// page opens (and quietly for "Ma liste" / "Continuer"), every enabled source is searched with
// the series' titles (english, romaji, synonyms, native), candidates are ranked (`match.ts`) and
// the best one is linked when it is unambiguous. Candidates are kept per series so "Ce n'est pas
// le bon ?" can offer them, and a refused link is never picked again automatically.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useSyncExternalStore } from 'react';

import { gql } from '@/data/anilist-api';
import { getSeries, type Series } from '@/data/catalog';
import { isDemo } from '@/demo/flags';

import { mangaChapters, mangaDetails, searchSource } from './api';
import { isCloudflareError } from './cloudflare-core';
import { getSourceLink, openSourceManga, setRejectedLookup, unlink } from './link';
import {
  AUTO_LINK_SCORE,
  chapterPlausibility,
  rankCandidates,
  searchQueries,
  titleSimilarity,
  type Candidate,
  type RankedCandidate,
  type SeriesTitles,
} from './match';
import { getMangaExt } from './registry';

export type MatchState = {
  at: number;
  candidates: RankedCandidate[];
  /** `sourceKey|mangaId` the user said are wrong. */
  rejected: string[];
  /** The user picked the link himself: never replaced automatically. */
  manual?: boolean;
};

type Status = 'idle' | 'searching' | 'linked' | 'none' | 'error';

const KEY = 'huwa/pb/matches/v1';
const TITLES_KEY = 'huwa/pb/titles/v1';
const RETRY_AFTER = 24 * 3600e3;
const TITLES_TTL = 7 * 24 * 3600e3;
const MAX_ATTEMPTS = 2;

let matches: Record<string, MatchState> = {};
let titlesCache: Record<string, SeriesTitles & { at: number }> = {};
const status = new Map<string, Status>();
/** Sources that were blocked by Cloudflare during the last search for a series (button "Vérifier"). */
const blocked = new Map<string, { sourceKey: string; url?: string }>();
const running = new Map<string, Promise<void>>();
const listeners = new Set<() => void>();
let version = 0;
const emit = () => {
  version++;
  listeners.forEach((l) => l());
};
const save = () => AsyncStorage.setItem(KEY, JSON.stringify(matches)).catch(() => {});
const ref = (c: { sourceKey: string; mangaId: string }) => `${c.sourceKey}|${c.mangaId}`;

// Opening a source title must not land on a page the user refused for it.
setRejectedLookup(async (r) => {
  await hydrate();
  return new Set(Object.entries(matches).filter(([, m]) => m.rejected.includes(r)).map(([id]) => id));
});

let hydration: Promise<void> | undefined;
function hydrate() {
  hydration ??= (async () => {
    try {
      const [m, t] = await Promise.all([AsyncStorage.getItem(KEY), AsyncStorage.getItem(TITLES_KEY)]);
      if (m) matches = { ...(JSON.parse(m) as Record<string, MatchState>), ...matches };
      if (t) titlesCache = { ...(JSON.parse(t) as typeof titlesCache), ...titlesCache };
    } catch {
      // start empty
    }
  })();
  return hydration;
}

function patch(seriesId: string, p: Partial<MatchState>) {
  const cur = matches[seriesId] ?? { at: 0, candidates: [], rejected: [] };
  matches = { ...matches, [seriesId]: { ...cur, ...p } };
  emit();
  save();
}
function setStatus(seriesId: string, s: Status) {
  status.set(seriesId, s);
  emit();
}

// ---------- titles ----------

type TitleNode = {
  type?: string;
  countryOfOrigin?: string | null;
  status?: string | null;
  chapters: number | null;
  synonyms: string[] | null;
  title: { english: string | null; romaji: string | null; native: string | null; userPreferred: string | null };
};
const TITLE_FIELDS = 'type countryOfOrigin status chapters synonyms title { english romaji native userPreferred }';

function titlesOf(n: TitleNode, fallback: string): SeriesTitles {
  const list = [n.title.english, n.title.romaji, n.title.userPreferred, fallback, ...(n.synonyms ?? []).slice(0, 8), n.title.native].filter(
    (t): t is string => !!t && t.trim().length > 1,
  );
  return { titles: [...new Set(list)], chapters: n.chapters, finished: n.status === 'FINISHED' || n.status === 'CANCELLED' };
}

/** Every known title of a series (AniList), cached for a week. */
export async function seriesTitles(series: Series): Promise<SeriesTitles> {
  await hydrate();
  const hit = titlesCache[series.id];
  if (hit && Date.now() - hit.at < TITLES_TTL) return hit;
  const fallback: SeriesTitles = { titles: [series.title], chapters: null, finished: series.status === 'completed' };
  const m = /^al(m?)(\d+)$/.exec(series.id);
  if (!m || isDemo) return fallback;
  try {
    let node: TitleNode | undefined;
    if (m[1]) {
      node = (await gql<{ Media: TitleNode }>(`query ($id: Int) { Media(id: $id, type: MANGA) { ${TITLE_FIELDS} } }`, { id: Number(m[2]) })).Media;
    } else {
      const data = await gql<{ Media: { relations: { edges: { relationType: string; node: TitleNode }[] } } }>(
        `query ($id: Int) { Media(id: $id, type: ANIME) { relations { edges { relationType(version: 2) node { ${TITLE_FIELDS} } } } } }`,
        { id: Number(m[2]) },
      );
      node = data.Media.relations.edges.find((e) => e.relationType === 'SOURCE' && e.node.type === 'MANGA')?.node;
    }
    if (!node) return fallback;
    const out = titlesOf(node, series.title);
    titlesCache = { ...titlesCache, [series.id]: { ...out, at: Date.now() } };
    AsyncStorage.setItem(TITLES_KEY, JSON.stringify(titlesCache)).catch(() => {});
    return out;
  } catch {
    return fallback;
  }
}

// ---------- search ----------

const enabledSources = () => {
  const { installed, showAdult } = getMangaExt();
  return installed.filter((s) => s.enabled && (showAdult || s.contentRating !== 'ADULT'));
};

async function candidatesFrom(sourceKey: string, target: SeriesTitles): Promise<Candidate[]> {
  const out: Candidate[] = [];
  for (const q of searchQueries(target.titles, 3)) {
    const page = await searchSource(sourceKey, q);
    for (const item of page.items.slice(0, 12)) {
      if (!out.some((c) => c.mangaId === item.mangaId)) {
        out.push({ sourceKey, mangaId: item.mangaId, title: item.title, image: item.image, subtitle: item.subtitle });
      }
    }
    // An exact title is good enough: don't hit the site again with the other titles.
    if (page.items.some((i) => target.titles.some((t) => titleSimilarity(t, i.title) === 1))) break;
  }
  return out;
}

/**
 * Searches every enabled source and links the best candidate when it is unambiguous. Safe to
 * call often: one run per series at a time, and a series without a match is retried once a day.
 */
export function autoLink(seriesId: string, opts: { force?: boolean } = {}): Promise<void> {
  const existing = running.get(seriesId);
  if (existing) return existing;
  const run = (async () => {
    await hydrate();
    const series = getSeries(seriesId);
    if (!series?.manhwa || seriesId.startsWith('px')) return;
    if (getSourceLink(seriesId) && !opts.force) return;
    const prev = matches[seriesId];
    if (!opts.force && prev && (prev.manual || Date.now() - prev.at < RETRY_AFTER)) return;
    const sources = enabledSources();
    if (!sources.length) return;

    setStatus(seriesId, 'searching');
    const target = await seriesTitles(series);
    const found = await Promise.allSettled(sources.map((s) => candidatesFrom(s.key, target)));
    const cf = found.find((r): r is PromiseRejectedResult => r.status === 'rejected' && isCloudflareError(r.reason));
    if (cf) blocked.set(seriesId, { sourceKey: cf.reason.sourceKey, url: cf.reason.url });
    else blocked.delete(seriesId);
    const all = found.flatMap((r) => (r.status === 'fulfilled' ? r.value : []));
    const rejected = new Set(prev?.rejected ?? []);
    const ranked = rankCandidates(target, all, sources.map((s) => s.key)).slice(0, 12);
    patch(seriesId, { at: Date.now(), candidates: ranked });
    if (getSourceLink(seriesId) && !opts.force) return setStatus(seriesId, 'linked');

    let attempts = 0;
    for (const c of ranked) {
      if (c.score < AUTO_LINK_SCORE || attempts >= MAX_ATTEMPTS) break;
      if (rejected.has(ref(c))) continue;
      attempts++;
      try {
        await openSourceManga(c.sourceKey, c.mangaId, { seriesId });
        // Sanity check with the real chapter count (a 3-chapter "Solo Leveling" is something else).
        const count = getSeries(seriesId)?.manhwa?.chapters.length ?? 0;
        if (chapterPlausibility(target, count) < 0.5) {
          unlink(seriesId);
          continue;
        }
        patch(seriesId, { candidates: ranked.map((x) => (ref(x) === ref(c) ? { ...x, chapters: count } : x)) });
        return setStatus(seriesId, 'linked');
      } catch {
        // source failed on details / chapters: try the next candidate
      }
    }
    setStatus(seriesId, all.length || found.some((r) => r.status === 'fulfilled') ? 'none' : 'error');
  })()
    .catch(() => setStatus(seriesId, 'error'))
    .finally(() => running.delete(seriesId));
  running.set(seriesId, run);
  return run;
}

/** The user picked this result himself (link picker). */
export async function linkManually(seriesId: string, c: Pick<Candidate, 'sourceKey' | 'mangaId'>) {
  await hydrate();
  await openSourceManga(c.sourceKey, c.mangaId, { seriesId, interactive: true });
  patch(seriesId, { manual: true, rejected: (matches[seriesId]?.rejected ?? []).filter((r) => r !== ref(c)) });
  setStatus(seriesId, 'linked');
}

/** "Ce n'est pas le bon" / "Délier": forget the link and never pick it again automatically. */
export async function rejectLink(seriesId: string) {
  await hydrate();
  const link = getSourceLink(seriesId);
  if (link) {
    const r = `${link.key}|${link.mangaId}`;
    const cur = matches[seriesId]?.rejected ?? [];
    patch(seriesId, { rejected: cur.includes(r) ? cur : [...cur, r], manual: true });
  }
  unlink(seriesId);
  setStatus(seriesId, 'idle');
}

/**
 * Background pass over the library ("Ma liste", "Continuer"): a few series per session, one at
 * a time, spaced out so sources aren't hammered.
 */
let libraryPass: Promise<void> | undefined;
export function autoLinkLibrary(seriesIds: string[], max = 8) {
  libraryPass ??= (async () => {
    await hydrate();
    const todo = [...new Set(seriesIds)].filter((id) => getSeries(id)?.manhwa && !getSourceLink(id) && !id.startsWith('px')).slice(0, max);
    for (const id of todo) {
      await autoLink(id);
      await new Promise((r) => setTimeout(r, 1500));
    }
  })().catch(() => {});
  return libraryPass;
}

/**
 * Chapter counts of the best proposals of a series ("Trouvé dans Asura Scans · 98 ch."): a
 * details + chapters call per candidate, at most `max`, cached with the candidates. `isCancelled`
 * stops between calls (the page was left).
 */
export async function probeCandidates(seriesId: string, max = 2, isCancelled: () => boolean = () => false) {
  await hydrate();
  const m = matches[seriesId];
  if (!m) return;
  const todo = m.candidates.filter((c) => c.chapters === undefined && !m.rejected.includes(ref(c))).slice(0, max);
  for (const c of todo) {
    if (isCancelled()) return;
    try {
      const details = await mangaDetails(c.sourceKey, c.mangaId);
      if (isCancelled()) return;
      const list = await mangaChapters(c.sourceKey, details);
      const count = new Set(list.map((x) => `${x.lang}|${x.number}`)).size;
      const cur = matches[seriesId];
      if (cur) patch(seriesId, { candidates: cur.candidates.map((x) => (ref(x) === ref(c) ? { ...x, chapters: count } : x)) });
    } catch {
      // unreachable / blocked source: no count, the proposal stays
    }
  }
}

export const getBlocked = (seriesId: string) => blocked.get(seriesId);

export function useAutoLink(seriesId: string): { status: Status; match?: MatchState; blocked?: { sourceKey: string; url?: string } } {
  useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
    () => version,
  );
  useEffect(() => {
    hydrate().then(emit);
  }, []);
  return { status: status.get(seriesId) ?? 'idle', match: matches[seriesId], blocked: blocked.get(seriesId) };
}
