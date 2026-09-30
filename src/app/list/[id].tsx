import { useLocalSearchParams } from 'expo-router';
import { ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SeriesGrid } from '@/components/lists';
import { ScreenHeader, StateView } from '@/components/states';
import { useT } from '@/i18n';
import { useLists, WATCH_STATUSES, type WatchStatus } from '@/store/lists';
import { useStore } from '@/store/store';
import { C, S } from '@/theme/tokens';

/** One list: `mylist`, `status-<status>` or a custom list id. */
export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const t = useT();
  const myList = useStore((s) => s.myList);
  const custom = useLists((s) => s.lists.find((l) => l.id === id));
  const statuses = useLists((s) => s.status);

  const status = id?.startsWith('status-') ? (id.slice(7) as WatchStatus) : null;
  let title = t('lists.myList');
  let ids = myList;
  if (status && WATCH_STATUSES.includes(status)) {
    title = t(`lists.status.${status}`);
    ids = Object.keys(statuses).filter((k) => statuses[k] === status);
  } else if (id !== 'mylist') {
    title = custom?.name ?? t('error.notFound');
    ids = custom?.seriesIds ?? [];
  }

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingBottom: insets.bottom + S.xxl, gap: S.md }}>
      <ScreenHeader title={title} />
      {ids.length === 0 ? <StateView icon="albums-outline" title={t('lists.emptyList')} /> : <SeriesGrid ids={ids} />}
    </ScrollView>
  );
}
