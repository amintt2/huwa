import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useState } from 'react';
import { Alert, Pressable, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { STATUS_ICON } from '@/components/lists';
import { Group, Row, ScreenHeader, StateView } from '@/components/states';
import { Button } from '@/components/ui';
import { useT } from '@/i18n';
import { createList, deleteList, renameList, useLists, WATCH_STATUSES } from '@/store/lists';
import { useStore } from '@/store/store';
import { C, F, R, S } from '@/theme/tokens';

export default function Lists() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const myList = useStore((s) => s.myList);
  const lists = useLists((s) => s.lists);
  const statuses = useLists((s) => s.status);
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const counts = WATCH_STATUSES.map((st) => Object.values(statuses).filter((x) => x === st).length);

  const create = () => {
    if (!name.trim()) return;
    createList(name);
    setName('');
  };

  const confirmDelete = (id: string, listName: string) =>
    Alert.alert(t('lists.deleteTitle', { name: listName }), t('lists.deleteBody'), [
      { text: t('common.cancel'), style: 'cancel' },
      { text: t('common.delete'), style: 'destructive', onPress: () => deleteList(id) },
    ]);

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ paddingTop: insets.top + S.sm, paddingBottom: insets.bottom + S.xxl, gap: S.xl }}>
      <ScreenHeader title={t('lists.title')} />

      <View style={{ paddingHorizontal: S.lg, gap: S.xl }}>
        <Group>
          <Row
            icon="bookmark"
            label={t('lists.myList')}
            hint={t('lists.count', { n: myList.length })}
            onPress={() => router.push({ pathname: '/list/[id]', params: { id: 'mylist' } })}
            last
          />
        </Group>

        <Group title={t('lists.byStatus')}>
          {WATCH_STATUSES.map((st, i) => (
            <Row
              key={st}
              icon={STATUS_ICON[st]}
              label={t(`lists.status.${st}`)}
              hint={t('lists.count', { n: counts[i] })}
              onPress={() => router.push({ pathname: '/list/[id]', params: { id: `status-${st}` } })}
              last={i === WATCH_STATUSES.length - 1}
            />
          ))}
        </Group>

        <Group title={t('lists.title')}>
          {lists.length === 0 && <StateView compact icon="albums-outline" title={t('lists.empty')} />}
          {lists.map((l) =>
            editing === l.id ? (
              <View key={l.id} style={styles.editRow}>
                <TextInput
                  value={draft}
                  onChangeText={setDraft}
                  autoFocus
                  maxLength={40}
                  returnKeyType="done"
                  onSubmitEditing={() => {
                    renameList(l.id, draft);
                    setEditing(null);
                  }}
                  accessibilityLabel={t('common.rename')}
                  style={[styles.input, { flex: 1 }]}
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={t('common.save')}
                  hitSlop={8}
                  onPress={() => {
                    renameList(l.id, draft);
                    setEditing(null);
                  }}>
                  <Ionicons name="checkmark-circle" size={28} color={C.accentText} />
                </Pressable>
              </View>
            ) : (
              <Row
                key={l.id}
                icon="albums-outline"
                label={l.name}
                hint={t('lists.count', { n: l.seriesIds.length })}
                onPress={() => router.push({ pathname: '/list/[id]', params: { id: l.id } })}
                right={
                  <View style={{ flexDirection: 'row', gap: S.md }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${t('common.rename')} ${l.name}`}
                      hitSlop={10}
                      onPress={() => {
                        setDraft(l.name);
                        setEditing(l.id);
                      }}>
                      <Ionicons name="pencil" size={18} color={C.text2} />
                    </Pressable>
                    <Pressable accessibilityRole="button" accessibilityLabel={`${t('common.delete')} ${l.name}`} hitSlop={10} onPress={() => confirmDelete(l.id, l.name)}>
                      <Ionicons name="trash-outline" size={18} color={C.text2} />
                    </Pressable>
                  </View>
                }
              />
            ),
          )}
        </Group>

        <View style={{ gap: S.sm }}>
          <TextInput
            value={name}
            onChangeText={setName}
            onSubmitEditing={create}
            placeholder={t('lists.namePlaceholder')}
            placeholderTextColor={C.text2}
            maxLength={40}
            returnKeyType="done"
            accessibilityLabel={t('lists.namePlaceholder')}
            style={styles.input}
          />
          <Button label={t('lists.new')} icon="add" variant="soft" onPress={create} />
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  input: {
    minHeight: 48, paddingHorizontal: S.lg, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, color: C.text, ...F.medium, fontSize: 16,
  },
  editRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, padding: S.sm },
});
