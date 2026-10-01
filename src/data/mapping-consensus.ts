// From the proposals of a manhwa room to the community state of each season (pure, unit-tested):
// proposals that do not fit the season (src/data/mapping.ts `validateProposal`) or come from
// blocked authors are ignored, the rest is tallied by src/social/consensus.ts.
import type { MappingProposal } from '@/p2p/contract';
import { tallyAll, type ConsensusRules, type Vote } from '@/social/consensus';

import { fieldKey, validateProposal, valueKey, type ProposalValue, type SeasonContext } from './mapping';
import type { FieldState, SeasonState } from './mapping-store';

export const toValue = (p: Pick<MappingProposal, 'field' | 'ep' | 'from' | 'to'>): ProposalValue =>
  p.field === 'end' ? { field: 'end', to: p.to } : { field: 'ep', ep: p.ep ?? 0, from: p.from ?? 0, to: p.to };

export type SeasonStatesOptions = {
  /** Seasons the reader can check (episodes, start…); proposals for other seasons are skipped. */
  contexts: Record<string, SeasonContext | undefined>;
  weightOf: (author: string) => number;
  blocked?: Set<string>;
  me?: string;
  rules?: ConsensusRules;
};

/** Community state of every season that has a context (undefined: nothing to show). */
export function computeSeasonStates(proposals: MappingProposal[], opts: SeasonStatesOptions): Record<string, SeasonState | undefined> {
  const bySeason = new Map<string, MappingProposal[]>();
  for (const p of proposals) bySeason.set(p.season, [...(bySeason.get(p.season) ?? []), p]);
  const out: Record<string, SeasonState | undefined> = {};
  for (const id of Object.keys(opts.contexts)) out[id] = undefined;

  for (const [season, list] of bySeason) {
    const ctx = opts.contexts[season];
    if (!ctx) continue;
    const votes: Vote<ProposalValue>[] = list.map((p) => {
      const value = toValue(p);
      return { author: p.author, field: fieldKey(value), value, key: valueKey(value), ts: p.ts };
    });
    const tallies = tallyAll(votes, {
      weightOf: opts.weightOf,
      blocked: opts.blocked,
      valid: (v) => validateProposal(v, ctx) === null,
      rules: opts.rules,
    });
    const mine = new Map<string, Vote<ProposalValue>>();
    for (const v of votes) {
      if (v.author !== opts.me) continue;
      const prev = mine.get(v.field);
      if (!prev || v.ts > prev.ts) mine.set(v.field, v);
    }

    const state: SeasonState = {};
    for (const [field, t] of tallies) {
      if (!t.leader) continue;
      const v = t.leader.value;
      const f: FieldState = {
        to: v.to,
        confirmations: t.leader.authors.length,
        verified: t.verified,
      };
      if (v.field === 'ep') f.from = v.from;
      const m = mine.get(field);
      if (m) f.mine = m.key;
      if (v.field === 'end') state.end = f;
      else (state.eps ??= {})[v.ep] = f;
    }
    out[season] = state.end || state.eps ? state : undefined;
  }
  return out;
}
