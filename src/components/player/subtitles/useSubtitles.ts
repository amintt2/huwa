// Track list + selection + loading for one player.
//   - tracks: embedded in the video (expo-video `availableSubtitleTracks`, drawn natively),
//     external files from addons (drawn by SubtitleOverlay), local files picked by the user
//   - automatic choice from the preferred languages until the user picks a track
//   - per-episode sync offset
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useEffect, useMemo, useState } from 'react';
import { Platform } from 'react-native';

import { useSettings } from '@/settings/settings';
import { formatFromName, parseSubtitleBytes, parseSubtitleText, SubtitleParseError, type ParsedFile } from '@/subtitles/parse';
import { preferLanguage, setSubtitleOffset, setSubtitlePrefs, useSubtitleOffset, useSubtitlePrefs } from '@/subtitles/prefs';
import { buildTracks, chooseTrack, groupTracks, type EmbeddedInput, type Track } from '@/subtitles/select';
import type { SubtitleDoc, SubtitleFormat } from '@/subtitles/types';

export type ExternalSubtitle = {
  url: string;
  lang: string;
  label: string;
  /** Addon (or stream) that provided the file. */
  source?: string;
  format?: SubtitleFormat;
  forced?: boolean;
};

// ---------- loading ----------

const cache = new Map<string, Promise<ParsedFile>>();

async function fetchBytes(url: string): Promise<Uint8Array> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  try {
    return new Uint8Array(await r.arrayBuffer());
  } catch {
    // Very old fetch polyfills: text only (UTF-8 assumed).
    const text = await r.text();
    return new TextEncoder().encode(text);
  }
}

/** Fetches, decompresses, decodes and parses a subtitle URL (cached per URL). */
export function loadSubtitleDoc(url: string): Promise<ParsedFile> {
  let p = cache.get(url);
  if (!p) {
    p = fetchBytes(url).then((bytes) => parseSubtitleBytes(bytes, formatFromName(url)));
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

export function errorMessage(e: unknown): string {
  if (e instanceof SubtitleParseError) return e.message;
  if (e instanceof Error && /^HTTP \d+/.test(e.message)) return `Sous-titres injoignables (${e.message}).`;
  return 'Sous-titres injoignables ou illisibles.';
}

/** Lets the user pick a subtitle file. Resolves null if cancelled; throws a readable error. */
export async function pickSubtitleFile(): Promise<{ name: string; parsed: ParsedFile } | null> {
  const res = await DocumentPicker.getDocumentAsync({ type: '*/*', copyToCacheDirectory: true, multiple: false });
  if (res.canceled || !res.assets?.length) return null;
  const asset = res.assets[0];
  const name = asset.name || 'Fichier';
  const hint = formatFromName(name);
  if (Platform.OS === 'web' && asset.file) {
    return { name, parsed: parseSubtitleBytes(new Uint8Array(await asset.file.arrayBuffer()), hint) };
  }
  const file = new File(asset.uri);
  if (file.size > 20 * 1024 * 1024) throw new SubtitleParseError('Fichier trop volumineux pour des sous-titres.');
  const bytes = await file.bytes();
  return { name, parsed: parseSubtitleBytes(bytes, hint) };
}

// ---------- controller ----------

type LocalTrack = { track: Track; doc: SubtitleDoc };
type LoadState = { url?: string; doc: SubtitleDoc | null; error?: string };

export function useSubtitleController({
  external,
  embedded,
  mediaKey,
}: {
  external: ExternalSubtitle[];
  embedded: EmbeddedInput[];
  /** Episode id: the sync offset is remembered per episode. */
  mediaKey?: string;
}) {
  const prefs = useSubtitlePrefs();
  const { subLangs, watchMode } = useSettings();
  const [locals, setLocals] = useState<LocalTrack[]>([]);
  const [userKey, setUserKey] = useState<string | undefined>();
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | undefined>();

  const tracks = useMemo(
    () =>
      buildTracks(
        embedded,
        external.map((x) => ({ url: x.url, lang: x.lang, label: x.label, source: x.source, format: x.format, forced: x.forced })),
        locals.map((l) => l.track),
      ),
    [embedded, external, locals],
  );
  const autoKey = useMemo(
    () => chooseTrack(tracks, { enabled: prefs.enabled, languages: subLangs, forcedOnly: watchMode === 'dub' }),
    [tracks, prefs.enabled, subLangs, watchMode],
  );
  const key = userKey && (userKey === 'off' || tracks.some((t) => t.key === userKey)) ? userKey : autoKey;
  const selected = tracks.find((t) => t.key === key);

  // External file for the selected track.
  const url = selected?.kind === 'external' ? selected.url : undefined;
  const [load, setLoad] = useState<LoadState>({ doc: null });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    loadSubtitleDoc(url)
      .then((p) => alive && setLoad({ url, doc: p.doc }))
      .catch((e: unknown) => alive && setLoad({ url, doc: null, error: errorMessage(e) }));
    return () => {
      alive = false;
    };
  }, [url]);
  const current = !!url && load.url === url;
  const local = selected?.kind === 'local' ? locals.find((l) => l.track.key === selected.key) : undefined;
  const doc = local ? local.doc : current ? load.doc : null;

  const offset = useSubtitleOffset(mediaKey);

  const select = (k: string) => {
    setUserKey(k);
    setPickError(undefined);
    if (k === 'off') return setSubtitlePrefs({ enabled: false });
    const t = tracks.find((x) => x.key === k);
    if (t && t.kind !== 'local') preferLanguage(t.lang);
  };

  const addLocalFile = async () => {
    if (picking) return;
    setPicking(true);
    setPickError(undefined);
    try {
      const res = await pickSubtitleFile();
      if (!res) return;
      const n = locals.length + 1;
      const track: Track = {
        key: `local:${n}:${res.name}`,
        kind: 'local',
        lang: 'und',
        source: res.name,
        format: res.parsed.doc.format,
        forced: false,
        name: res.name,
        sourceRank: -1,
      };
      setLocals((l) => [...l, { track, doc: res.parsed.doc }]);
      setUserKey(track.key);
    } catch (e) {
      setPickError(e instanceof SubtitleParseError ? e.message : 'Fichier illisible.');
    } finally {
      setPicking(false);
    }
  };

  return {
    tracks,
    groups: groupTracks(tracks.filter((t) => t.kind !== 'local'), subLangs),
    locals: locals.map((l) => l.track),
    selectedKey: key,
    selected,
    select,
    /** Parsed document to draw (external or local track), null for embedded / off. */
    doc,
    loading: !!url && !current,
    error: current ? load.error : pickError,
    /** Index in `availableSubtitleTracks` to enable natively, -1 for none. */
    embeddedIndex: selected?.kind === 'embedded' ? selected.embeddedIndex ?? -1 : -1,
    offset,
    setOffset: (v: number) => setSubtitleOffset(mediaKey, v),
    canOffset: !!mediaKey,
    addLocalFile,
    picking,
    loadedFormat: doc?.format,
  };
}

export type SubtitleController = ReturnType<typeof useSubtitleController>;

// ---------- compatibility API (plain cues), for simple players ----------

export type Cue = { start: number; end: number; text: string };

export function docToCues(doc: SubtitleDoc): Cue[] {
  return doc.events.map((e) => ({ start: e.start, end: e.end, text: e.plain }));
}

/** Parses SRT / WebVTT / ASS text into plain cues. */
export function parseSubtitles(raw: string): Cue[] {
  return docToCues(parseSubtitleText(raw));
}

/** Text shown at `t` (overlapping cues joined with a line break). */
export function cueAt(cues: Cue[], t: number): string | null {
  const out = cues.filter((c) => c.start <= t && c.end > t).map((c) => c.text);
  return out.length ? out.join('\n') : null;
}

/** Fetches + parses one external file into plain cues. */
export function useCues(url: string | undefined) {
  const [state, setState] = useState<{ url?: string; cues: Cue[]; error: boolean }>({ cues: [], error: false });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    loadSubtitleDoc(url)
      .then((p) => alive && setState({ url, cues: docToCues(p.doc), error: false }))
      .catch(() => alive && setState({ url, cues: [], error: true }));
    return () => {
      alive = false;
    };
  }, [url]);
  const cur = !!url && state.url === url;
  return { cues: cur ? state.cues : [], loading: !!url && !cur, error: cur && state.error };
}
