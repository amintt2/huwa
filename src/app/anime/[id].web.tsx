// Web anime page: the native page in a centered column over the series art on wide screens
// (src/web/column.tsx). Episodes stay public; playing one opens the sign-in sheet when signed out.
import { useLocalSearchParams } from 'expo-router';

import { getSeries, useCatalog } from '@/data/catalog';
import { WideColumn } from '@/web/column';

import type Screen from './[id]';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const AnimeDetail: typeof Screen = require('./[id].tsx').default;

export default function AnimeDetailWeb() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useCatalog();
  const series = getSeries(id);
  return (
    <WideColumn backdrop={series?.banner ?? series?.image}>
      <AnimeDetail />
    </WideColumn>
  );
}
