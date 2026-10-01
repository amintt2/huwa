// Community auto-hide (pure, unit-tested). Reports ("flags") are signed by their author and
// published in the work's flag room; every reader computes the outcome locally, with the same
// Sybil resistance as the episode ↔ chapter corrections (src/social/consensus.ts):
//   - one active flag per (author, comment), the newest wins, a retraction removes it,
//   - each author weighs by the rank recomputed from their journal (new identities weigh 0.1),
//   - blocked authors (by me or my lists) and the comment's own author are ignored,
//   - a comment is collapsed only with enough distinct authors AND enough weight.
// Nothing is deleted: the comment stays one tap away ("Masqué par la communauté — afficher").
import type { CommentFlag, FlagReason } from '../p2p/contract';

export const FLAG_REASONS: { val: FlagReason; label: string; detail: string }[] = [
  { val: 'spoiler', label: 'Spoiler non signalé', detail: 'Révèle la suite sans être marqué spoiler.' },
  { val: 'abuse', label: 'Haine ou harcèlement', detail: 'Insulte, menace, attaque une personne ou un groupe.' },
  { val: 'nsfw', label: 'Contenu sexuel', detail: 'Texte, lien ou GIF à caractère sexuel.' },
  { val: 'spam', label: 'Spam ou arnaque', detail: 'Publicité, liens piégés, messages répétés.' },
  { val: 'other', label: 'Autre chose', detail: 'Hors sujet, pénible ou inapproprié.' },
];
export const isFlagReason = (v: unknown): v is FlagReason => FLAG_REASONS.some((r) => r.val === v);

/** Labels written to my personal base (my own view, my published list) for a reason. */
export const LABEL_OF: Record<FlagReason, 'spoiler' | 'abuse' | 'nsfw' | 'spam' | 'hide'> = {
  spoiler: 'spoiler',
  abuse: 'abuse',
  nsfw: 'nsfw',
  spam: 'spam',
  other: 'hide',
};

export type HideRules = { minAuthors: number; minWeight: number; cap: number };
/** Collapse: 3 distinct people weighing at least 1.5 (e.g. 3 regulars, never 15 fresh keys). */
export const HIDE_RULES: HideRules = { minAuthors: 3, minWeight: 1.5, cap: 1 };
/** Spoiler blur is milder than collapsing: 2 people weighing at least 1. */
export const SPOILER_RULES: HideRules = { minAuthors: 2, minWeight: 1, cap: 1 };

export type CommunityVerdict = {
  /** Collapsed behind "Masqué par la communauté". */
  hidden: boolean;
  /** Blurred as a spoiler. */
  spoiler: boolean;
  /** Distinct (counted) authors and their total weight, all reasons. */
  authors: number;
  weight: number;
  /** Reasons by weight, heaviest first. */
  reasons: FlagReason[];
};

/** Newest flag per (author, comment); ties: the higher reason, for determinism. */
export function latestFlags(flags: CommentFlag[]): CommentFlag[] {
  const latest = new Map<string, CommentFlag>();
  for (const f of flags) {
    const k = `${f.author}\u0000${f.comment}`;
    const prev = latest.get(k);
    if (!prev || f.ts > prev.ts || (f.ts === prev.ts && f.reason > prev.reason)) latest.set(k, f);
  }
  return [...latest.values()];
}

export function communityVerdicts(
  flags: CommentFlag[],
  opts: {
    weightOf: (author: string) => number;
    /** Author of each comment (self-flags are ignored). */
    authorOf: (commentId: string) => string | undefined;
    blocked?: Set<string>;
    hide?: HideRules;
    spoiler?: HideRules;
  },
): Map<string, CommunityVerdict> {
  const hide = opts.hide ?? HIDE_RULES;
  const spoil = opts.spoiler ?? SPOILER_RULES;
  const per = new Map<string, { total: Map<string, number>; spoiler: Map<string, number>; byReason: Map<FlagReason, number> }>();
  for (const f of latestFlags(flags)) {
    if (opts.blocked?.has(f.author)) continue;
    const author = opts.authorOf(f.comment);
    if (author === undefined || author === f.author) continue;
    const w = Math.max(0, Math.min(hide.cap, opts.weightOf(f.author)));
    const g = per.get(f.comment) ?? { total: new Map(), spoiler: new Map(), byReason: new Map() };
    g.total.set(f.author, w);
    if (f.reason === 'spoiler') g.spoiler.set(f.author, w);
    g.byReason.set(f.reason, (g.byReason.get(f.reason) ?? 0) + w);
    per.set(f.comment, g);
  }
  const sum = (m: Map<string, number>) => [...m.values()].reduce((a, b) => a + b, 0);
  const out = new Map<string, CommunityVerdict>();
  for (const [comment, g] of per) {
    // Collapsing counts every reason but spoilers (a spoiler is blurred, not removed).
    const nonSpoiler = new Map([...g.total].filter(([a]) => !g.spoiler.has(a)));
    const hidden = nonSpoiler.size >= hide.minAuthors && sum(nonSpoiler) >= hide.minWeight - 1e-9;
    const spoiler = g.spoiler.size >= spoil.minAuthors && sum(g.spoiler) >= spoil.minWeight - 1e-9;
    const reasons = [...g.byReason].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1)).map(([r]) => r);
    out.set(comment, { hidden, spoiler, authors: g.total.size, weight: sum(g.total), reasons });
  }
  return out;
}

export const reasonLabel = (r: FlagReason) => FLAG_REASONS.find((x) => x.val === r)?.label ?? r;
