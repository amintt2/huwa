// Dev-only timings of an episode start: tap → screen → first sources → source chosen → URL ready
// → first frame. One line in the Metro console per episode once the first frame shows, e.g.
//   [huwa:start] al154587:3 · écran 180 ms · sources 420 ms (cache) · choix 900 ms · URL 900 ms · image 1650 ms
// Nothing is recorded in release builds.

declare const __DEV__: boolean | undefined;
const on = typeof __DEV__ !== 'undefined' && !!__DEV__;
const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export type StartMark = 'screen' | 'sources' | 'decision' | 'url' | 'first-frame';
type Trace = { t0: number; marks: Partial<Record<StartMark, number>>; notes: string[]; printed: boolean };

const traces = new Map<string, Trace>();
const LABEL: Record<StartMark, string> = { screen: 'écran', sources: 'sources', decision: 'choix', url: 'URL', 'first-frame': 'image' };

/** The user asked to play `episodeId` (button press). */
export function traceTap(episodeId: string) {
  if (!on) return;
  traces.set(episodeId, { t0: now(), marks: {}, notes: [], printed: false });
}

/** First occurrence of a step for this episode (later ones are ignored). */
export function traceMark(episodeId: string, mark: StartMark, note?: string) {
  if (!on) return;
  let t = traces.get(episodeId);
  // Opened without a tracked tap (deep link, "Épisode suivant"): time from the screen.
  if (!t || (mark === 'screen' && t.marks.screen != null)) {
    t = { t0: now(), marks: {}, notes: [], printed: false };
    traces.set(episodeId, t);
  }
  if (t.marks[mark] != null) return;
  t.marks[mark] = now() - t.t0;
  if (note) t.notes.push(`${LABEL[mark]}: ${note}`);
  if (mark === 'first-frame' && !t.printed) {
    t.printed = true;
    const parts = (Object.keys(LABEL) as StartMark[])
      .filter((k) => t!.marks[k] != null)
      .map((k) => `${LABEL[k]} ${Math.round(t!.marks[k]!)} ms`);
    console.log(`[huwa:start] ${episodeId} · ${parts.join(' · ')}${t.notes.length ? ` (${t.notes.join(', ')})` : ''}`);
  }
}
