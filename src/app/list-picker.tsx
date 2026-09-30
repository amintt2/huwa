import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { ScrollView, StyleSheet, TextInput, View } from 'react-native';

import { STATUS_ICON } from '@/components/lists';
import { FilterChip, Group, Row } from '@/components/states';
import { Button, Txt } from '@/components/ui';
import { getSeries } from '@/data/catalog';
import { useT } from '@/i18n';
import { createList, setWatchStatus, toggleInList, useLists, WATCH_STATUSES } from '@/store/lists';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, R, S } from '@/theme/tokens';

/** Sheet opened from a series page: status + "Ma liste" + custom lists. */
export default function ListPicker() {
  const { seriesId } = useLocalSearchParams<{ seriesId: string }>();
  const t = useT();
  const series = getSeries(seriesId);
  const inMyList = useStore((s) => s.myList.includes(seriesId));
  const lists = useLists((s) => s.lists);
  const status = useLists((s) => s.status[seriesId]);
  const [name, setName] = useState('');

  const create = () => {
    if (!name.trim()) return;
    const id = createList(name);
    toggleInList(id, seriesId);
    setName('');
  };

  const check = (on: boolean) => (
    <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={24} color={on ? C.accentText : C.text2} />
  );

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: S.lg, paddingTop: S.xl, gap: S.xl }}>
      <View style={{ gap: 4 }}>
        <Txt v="caption">{t('lists.addTo')}</Txt>
        <Txt v="title" numberOfLines={2}>{series?.title ?? ''}</Txt>
      </View>

      <View style={{ gap: S.sm }}>
        <Txt v="caption">{t('lists.status')}</Txt>
        <View style={styles.wrap}>
          <FilterChip label={t('lists.status.none')} selected={!status} onPress={() => setWatchStatus(seriesId, null)} />
          {WATCH_STATUSES.map((st) => (
            <FilterChip key={st} icon={STATUS_ICON[st]} label={t(`lists.status.${st}`)} selected={status === st} onPress={() => setWatchStatus(seriesId, st)} />
          ))}
        </View>
      </View>

      <Group title={t('lists.title')}>
        <Row icon="bookmark" label={t('lists.myList')} onPress={() => toggleMyList(seriesId)} right={check(inMyList)} last={lists.length === 0} />
        {lists.map((l, i) => {
          const on = l.seriesIds.includes(seriesId);
          return (
            <Row key={l.id} icon="albums-outline" label={l.name} hint={t('lists.count', { n: l.seriesIds.length })} onPress={() => toggleInList(l.id, seriesId)} right={check(on)} last={i === lists.length - 1} />
          );
        })}
      </Group>

      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <TextInput
          value={name}
          onChangeText={setName}
          onSubmitEditing={create}
          placeholder={t('lists.new')}
          placeholderTextColor={C.text2}
          maxLength={40}
          returnKeyType="done"
          accessibilityLabel={t('lists.namePlaceholder')}
          style={styles.input}
        />
        <Button small label={t('common.create')} icon="add" variant="soft" onPress={create} />
      </View>

      <Button label={t('lists.manage')} variant="ghost" icon="albums-outline" onPress={() => {
        router.back();
        router.push('/lists');
      }} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  input: {
    flex: 1, minHeight: 44, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, color: C.text, ...F.medium, fontSize: 15,
  },
});
