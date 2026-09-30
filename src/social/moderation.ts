// Local moderation filter (PLAN §4). Masking is always a *local view*, never a deletion:
// the shared log stays deterministic and non-censoring.
import type { Label } from '../p2p/contract';

export type ModerationContext = {
  me?: string;
  /** Labels from me and from the lists I subscribe to (as delivered by `watchLabels`). */
  labels: Label[];
  /** Labelers I subscribe to. Labels from anyone else (except me) are ignored. */
  subscriptions: string[];
  /** Blocks from this many distinct subscriptions hide an author. */
  threshold?: number;
  /** Local muted words / expressions. */
  words?: string[];
};

/** Latest label per (by, target, val) wins; `neg` retracts it. */
export function activeLabels(labels: Label[]): Label[] {
  const latest = new Map<string, Label>();
  for (const l of labels) {
    const k = `${l.by}\u0000${l.target}\u0000${l.val}`;
    const prev = latest.get(k);
    if (!prev || prev.ts <= l.ts) latest.set(k, l);
  }
  return [...latest.values()].filter((l) => !l.neg);
}

/** Keys I block myself. */
export function myBlocks(me: string | undefined, labels: Label[]): Set<string> {
  return new Set(activeLabels(labels).filter((l) => l.by === me && l.val === 'hide').map((l) => l.target));
}

/**
 * Authors hidden for me:
 *  - anyone I block,
 *  - anyone blocked (`hide`/`spam`/`abuse`) by at least `threshold` distinct subscriptions — never me.
 */
export function hiddenAuthors({ me, labels, subscriptions, threshold = 2 }: ModerationContext): Set<string> {
  const subs = new Set(subscriptions);
  const hidden = myBlocks(me, labels);
  const votes = new Map<string, Set<string>>();
  for (const l of activeLabels(labels)) {
    if (l.by === me || !subs.has(l.by)) continue;
    if (l.val !== 'hide' && l.val !== 'spam' && l.val !== 'abuse') continue;
    const s = votes.get(l.target) ?? new Set<string>();
    s.add(l.by);
    votes.set(l.target, s);
  }
  for (const [target, by] of votes) if (by.size >= threshold && target !== me) hidden.add(target);
  hidden.delete(me ?? '');
  return hidden;
}

/** Lowercase, strip accents and punctuation so "Spöiler!!" matches "spoiler". */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Muted word or expression, matched on whole words. */
export function matchesWords(text: string, words: string[] = []): string | undefined {
  const hay = ` ${normalizeText(text)} `;
  for (const w of words) {
    const n = normalizeText(w);
    if (n && hay.includes(` ${n} `)) return w;
  }
  return undefined;
}

export type Filterable = { id: string; author: string; text: string; spoiler?: boolean };
export type Verdict = { hidden: boolean; reason?: 'bloqué' | 'liste' | 'mot' | 'signalé'; word?: string; spoiler: boolean };

/** Decide per item. Labels can also target a comment id (`hide` = masked, `spoiler` = forced spoiler). */
export function moderate<T extends Filterable>(items: T[], ctx: ModerationContext): Map<string, Verdict> {
  const act = activeLabels(ctx.labels);
  const subs = new Set(ctx.subscriptions);
  const trusted = (l: Label) => l.by === ctx.me || subs.has(l.by);
  const mine = myBlocks(ctx.me, ctx.labels);
  const authors = hiddenAuthors(ctx);
  // My own reports hide the item for me whatever the reason; lists only through `hide`.
  const hiddenIds = new Set(
    act.filter((l) => (l.by === ctx.me && l.val !== 'spoiler') || (trusted(l) && l.val === 'hide')).map((l) => l.target),
  );
  const spoilerIds = new Set(act.filter((l) => trusted(l) && l.val === 'spoiler').map((l) => l.target));

  const out = new Map<string, Verdict>();
  for (const it of items) {
    const spoiler = !!it.spoiler || spoilerIds.has(it.id);
    if (it.author === ctx.me) out.set(it.id, { hidden: false, spoiler });
    else if (mine.has(it.author)) out.set(it.id, { hidden: true, reason: 'bloqué', spoiler });
    else if (authors.has(it.author)) out.set(it.id, { hidden: true, reason: 'liste', spoiler });
    else if (hiddenIds.has(it.id)) out.set(it.id, { hidden: true, reason: 'signalé', spoiler });
    else {
      const word = matchesWords(it.text, ctx.words);
      out.set(it.id, word ? { hidden: true, reason: 'mot', word, spoiler } : { hidden: false, spoiler });
    }
  }
  return out;
}
