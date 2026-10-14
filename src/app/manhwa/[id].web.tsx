// Web manhwa page: the native page in a centered column over the series art on wide screens
// (src/web/column.tsx). Chapters stay public; reading one opens the sign-in sheet when signed out.
import { useLocalSearchParams } from 'expo-router';

import { getSeries, useCatalog } from '@/data/catalog';
import { WideColumn } from '@/web/column';

import type Screen from './[id]';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const ManhwaDetail: typeof Screen = require('./[id].tsx').default;

export default function ManhwaDetailWeb() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useCatalog();
  const series = getSeries(id);
  return (
    <WideColumn backdrop={series?.banner ?? series?.image}>
      <ManhwaDetail />
    </WideColumn>
  );
}
