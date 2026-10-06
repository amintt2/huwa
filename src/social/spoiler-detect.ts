// "Marquer comme spoiler ?" (pure, unit-tested): a comment that mentions a later episode or
// chapter than the one it is posted on probably spoils it. Only a prompt — the author decides.

export type SpoilerContext = {
  /** Episode the thread is about (anime threads). */
  episode?: number;
  /** Last chapter the reader may know: the chapter of a manhwa thread, or the last chapter an
   *  anime episode adapts (when known). */
  chapter?: number;
};

export type LaterRef = { kind: 'ep' | 'ch'; n: number };

// "épisode 14", "ep 14", "ép. 14", "E14", "S2E14" · "chapitre 120", "chap. 120", "ch 120", "C120".
const EP_RE = /(?:^|[^0-9A-Za-zÀ-ÖØ-öø-ÿ])(?:[ée]pisodes?|[ée]p\.?|s\d{1,2}\s?e|e(?=\d))\s?(\d{1,4})(?!\d)/gi;
const CH_RE = /(?:^|[^0-9A-Za-zÀ-ÖØ-öø-ÿ])(?:chapitres?|chapters?|chap\.?|ch\.?|c(?=\d))\s?(\d{1,5})(?!\d)/gi;

/** Spoiler spans and code are already hidden or quoted on purpose: not scanned. */
const visible = (text: string) => text.replace(/\|\|[\s\S]*?\|\|/g, ' ').replace(/`[^`]*`/g, ' ');

/** The highest later episode / chapter mentioned, or undefined. */
export function laterReference(text: string, ctx: SpoilerContext): LaterRef | undefined {
  const t = visible(text);
  let best: LaterRef | undefined;
  const scan = (re: RegExp, kind: LaterRef['kind'], current: number | undefined) => {
    if (current === undefined || !Number.isFinite(current)) return;
    re.lastIndex = 0;
    for (let m = re.exec(t); m; m = re.exec(t)) {
      const n = Number(m[1]);
      if (n > current && (!best || (best.kind === kind && n > best.n))) best = { kind, n };
    }
  };
  scan(EP_RE, 'ep', ctx.episode);
  scan(CH_RE, 'ch', ctx.chapter);
  return best;
}

export const laterReferenceLabel = (r: LaterRef) => (r.kind === 'ep' ? `l’épisode ${r.n}` : `le chapitre ${r.n}`);
