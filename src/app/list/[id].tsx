import { useLocalSearchParams } from 'expo-router';

import { SeriesGrid } from '@/components/lists';
import { Screen } from '@/components/screen';
import { StateView } from '@/components/states';
import { useT } from '@/i18n';
import { useLists, WATCH_STATUSES, type WatchStatus } from '@/store/lists';
import { useStore } from '@/store/store';
import { S } from '@/theme/tokens';

/** One list: `mylist`, `status-<status>` or a custom list id. */
export default function ListScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
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
    <Screen title={title} subtitle={ids.length ? t('lists.count', { n: ids.length }) : undefined} padded={false} gap={S.md}>
      {ids.length === 0 ? (
        <StateView icon="albums-outline" title={t('lists.emptyList')} body="Ajoute une série depuis sa fiche, avec le bouton « Ma liste »." />
      ) : (
        <SeriesGrid ids={ids} />
      )}
    </Screen>
  );
}
