// Web build of ./cards (same exports): the same cards, lifting on hover / keyboard focus
// (src/web/lift.tsx). Clicks still go through each card's own press handler.
import { Lift } from '@/web/lift';

import type * as Base from './cards';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const base: typeof Base = require('./cards.tsx');

export const { ScoreBadge } = base;

export function PosterCard(props: Parameters<typeof Base.PosterCard>[0]) {
  return (
    <Lift>
      <base.PosterCard {...props} />
    </Lift>
  );
}

export function ReleaseCard(props: Parameters<typeof Base.ReleaseCard>[0]) {
  return (
    <Lift>
      <base.ReleaseCard {...props} />
    </Lift>
  );
}

export function RankCard(props: Parameters<typeof Base.RankCard>[0]) {
  return (
    <Lift>
      <base.RankCard {...props} />
    </Lift>
  );
}

export function ContinueCard(props: Parameters<typeof Base.ContinueCard>[0]) {
  return (
    <Lift>
      <base.ContinueCard {...props} />
    </Lift>
  );
}
