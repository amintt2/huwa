// Community moderation of comment threads: reports (flags) of a work, weighed by the rank of their
// authors, applied on top of my own filters (src/social/moderation.ts). See src/social/community.ts.
import { useEffect, useMemo, useState } from 'react';

import { useAuthorXp } from '@/data/mapping-sync';
import { commentAnchor } from '@/social/anchors';
import { communityVerdicts, LABEL_OF, type CommunityVerdict } from '@/social/community';
import { authorWeight } from '@/social/consensus';
import { seriesOfTarget } from '@/social/migrate';
import { hiddenAuthors } from '@/social/moderation';

import type { CommentFlag, FlagReason } from './contract';
import { useComments, useMe, useModeration, type CommentView } from './hooks';
import { getP2P } from './index';
import { usePrefs } from './prefs';

const NO_FLAGS: CommentFlag[] = [];

export function useFlags(seriesId: string): CommentFlag[] {
  const [state, setState] = useState<{ id: string; list: CommentFlag[] }>();
  useEffect(() => getP2P().watchFlags(seriesId, (list) => setState({ id: seriesId, list })), [seriesId]);
  return state?.id === seriesId ? state.list : NO_FLAGS;
}

/** Weight of an author for reports and GIF trust: rank from their journal, a little more if followed. */
export function useAuthorWeights(authors: string[]) {
  const sorted = useMemo(() => [...new Set(authors)].sort(), [authors]);
  const xp = useAuthorXp(sorted);
  const follows = usePrefs((p) => p.follows);
  return useMemo(() => {
    const followed = new Set(follows);
    return (a: string) => authorWeight({ xp: xp[a], followed: followed.has(a) });
  }, [xp, follows]);
}

export type ThreadComment = CommentView & { community?: CommunityVerdict };

/**
 * A thread with my filters and the community verdicts: community-hidden comments stay in `visible`
 * (collapsed by the UI, one tap away), community spoilers are blurred.
 */
export function useCommunityThread(target: string) {
  const seriesId = seriesOfTarget(target);
  const thread = useComments(seriesId, target);
  const flags = useFlags(seriesId);
  const ctx = useModeration();
  const me = useMe()?.key;
  const flagAuthors = useMemo(() => flags.map((f) => f.author), [flags]);
  const weightOf = useAuthorWeights(flagAuthors);
  return useMemo(() => {
    const authors = new Map(thread.items.map((c) => [c.id, c.author]));
    const verdicts = communityVerdicts(
      flags.filter((f) => authors.has(f.comment)),
      { weightOf, authorOf: (id) => authors.get(id), blocked: hiddenAuthors(ctx) },
    );
    const mine = new Set(flags.filter((f) => f.author === me).map((f) => f.comment));
    const decorate = (c: CommentView): ThreadComment => {
      const v = verdicts.get(c.id);
      if (!v) return c;
      return { ...c, community: v, verdict: v.spoiler ? { ...c.verdict, spoiler: true } : c.verdict };
    };
    return {
      visible: thread.visible.map(decorate),
      hiddenCount: thread.hiddenCount,
      /** Comments I reported (to show "Signalé" instead of "Signaler"). */
      flaggedByMe: mine,
    };
  }, [thread, flags, weightOf, ctx, me]);
}

/**
 * Report a comment: hidden for me right away (label in my personal base, also my published list),
 * and a weighed report in the work's flag room for the community auto-hide.
 */
export async function reportComment(c: { id: string; target: string }, reason: FlagReason) {
  const p2p = getP2P();
  await p2p.report(c.id, LABEL_OF[reason]);
  // The community report is best effort (offline, rate limit): my own view is already updated.
  await p2p.flagComment(seriesOfTarget(c.target), c.id, reason).catch(() => {});
}

/**
 * Number of visible comments anchored on each page of a chapter (1-based page → count), for a
 * reader badge. Cheap: derived from the thread the reader already watches.
 */
export function usePageCommentCounts(chapterId: string): Map<number, number> {
  const { visible } = useComments(seriesOfTarget(`ch:${chapterId}`), `ch:${chapterId}`);
  return useMemo(() => {
    const out = new Map<number, number>();
    for (const c of visible) {
      if (c.deleted) continue;
      const a = commentAnchor(c).anchor;
      if (a?.type !== 'page') continue;
      for (let p = a.from; p <= (a.to ?? a.from); p++) out.set(p, (out.get(p) ?? 0) + 1);
    }
    return out;
  }, [visible]);
}
