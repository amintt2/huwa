// External subtitles (SRT / WebVTT). expo-video v57 only exposes the subtitle tracks embedded in
// the media (`availableSubtitleTracks`) and has no sidecar-file API, so external files are
// fetched, parsed here and drawn by the player as a synchronised overlay.
import { useEffect, useState } from 'react';

export type ExternalSubtitle = { url: string; lang: string; label: string };
export type Cue = { start: number; end: number; text: string };

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?/;

export function parseTimestamp(s: string): number {
  const m = TIME.exec(s.trim());
  if (!m) return NaN;
  const [, h, min, sec, ms] = m;
  return (Number(h ?? 0) * 3600) + Number(min) * 60 + Number(sec) + Number((ms ?? '0').padEnd(3, '0')) / 1000;
}

const clean = (line: string) =>
  line
    .replace(/\{\\[^}]*\}/g, '') // ASS overrides: {\an8}
    .replace(/<\/?(?:i|b|u|c|v|lang|ruby|rt|font)[^>]*>/gi, '')
    .replace(/<\d{2}:[^>]*>/g, '') // VTT karaoke timestamps
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .trim();

/** Parses SRT and WebVTT into cues sorted by start time. Unknown blocks (headers, NOTE, STYLE) are skipped. */
export function parseSubtitles(raw: string): Cue[] {
  const text = raw.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const cues: Cue[] = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const at = lines.findIndex((l) => l.includes('-->'));
    if (at < 0) continue;
    const [a, b] = lines[at].split('-->');
    const start = parseTimestamp(a);
    const end = parseTimestamp(b ?? '');
    if (!isFinite(start) || !isFinite(end) || end <= start) continue;
    const body = lines.slice(at + 1).map(clean).filter(Boolean).join('\n');
    if (body) cues.push({ start, end, text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** Text shown at `t` (overlapping cues are stacked). Binary search: called on every time update. */
export function cueAt(cues: Cue[], t: number): string | null {
  let lo = 0;
  let hi = cues.length - 1;
  let last = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) {
      last = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  const out: string[] = [];
  // Cues rarely overlap by more than a few entries; walk back a little.
  for (let i = last; i >= 0 && i > last - 6; i--) {
    if (cues[i].end > t) out.unshift(cues[i].text);
  }
  return out.length ? out.join('\n') : null;
}

const cache = new Map<string, Promise<Cue[]>>();

export function loadSubtitles(url: string): Promise<Cue[]> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(url)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.text();
      })
      .then(parseSubtitles);
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

type CueState = { url?: string; cues: Cue[]; error: boolean };

/** Fetches + parses the selected external subtitle file. */
export function useCues(url: string | undefined) {
  const [state, setState] = useState<CueState>({ cues: [], error: false });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    loadSubtitles(url)
      .then((cues) => alive && setState({ url, cues, error: false }))
      .catch(() => alive && setState({ url, cues: [], error: true }));
    return () => {
      alive = false;
    };
  }, [url]);
  const current = url && state.url === url;
  return { cues: current ? state.cues : [], loading: !!url && !current, error: !!current && state.error };
}
