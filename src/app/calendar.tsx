import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, ScrollView, SectionList, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ErrorState, FilterChip, LoadingView, ScreenHeader, StateView } from '@/components/states';
import { Cover, Press, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { fetchAiring, openMedia, type AiringItem } from '@/data/anilist-api';
import { useLocale, useT } from '@/i18n';
import { useLists } from '@/store/lists';
import { useStore } from '@/store/store';
import { C, F, R, S } from '@/theme/tokens';

const DAY = 86_400_000;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export default function Calendar() {
  const insets = useSafeAreaInsets();
  const t = useT();
  const locale = useLocale();
  const myList = useStore((s) => s.myList);
  const statuses = useLists((s) => s.status);
  const listRef = useRef<SectionList<AiringItem, { key: string; title: string; data: AiringItem[] }>>(null);

  const [items, setItems] = useState<AiringItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [today] = useState(startOfToday);
  const [now, setNow] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAiring(Math.floor(today / 1000), Math.floor((today + 7 * DAY) / 1000), ctrl.signal)
      .then((list) => {
        setItems(list);
        setNow(Date.now());
        setFailed(false);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [today, attempt]);

  /** Series the user follows: "Ma liste" + anything marked "En cours" / "À voir". */
  const followed = useMemo(() => {
    const ids = new Set(myList);
    for (const [id, st] of Object.entries(statuses)) if (st === 'watching' || st === 'planned') ids.add(id);
    return ids;
  }, [myList, statuses]);
  const isMine = (a: AiringItem) => followed.has(a.seriesId ?? `al${a.anilistId}`);

  const sections = useMemo(() => {
    const days = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(today + i * DAY);
      const title =
        i === 0
          ? t('calendar.today')
          : i === 1
            ? t('calendar.tomorrow')
            : date.toLocaleDateString(locale, { weekday: 'long', day: 'numeric', month: 'long' });
      return { key: String(i), title, short: i === 0 ? t('calendar.today') : date.toLocaleDateString(locale, { weekday: 'short', day: 'numeric' }), data: [] as AiringItem[] };
    });
    for (const a of items ?? []) {
      if (onlyMine && !followed.has(a.seriesId ?? `al${a.anilistId}`)) continue;
      const i = Math.floor((new Date(a.airingAt * 1000).setHours(0, 0, 0, 0) - today) / DAY);
      if (i >= 0 && i < 7) days[i].data.push(a);
    }
    return days;
  }, [items, onlyMine, followed, today, locale, t]);

  const mineCount = (items ?? []).filter(isMine).length;

  const open = async (a: AiringItem) => {
    if (opening) return;
    setOpening(a.id);
    try {
      router.push(await openMedia(a.anilistId, 'ANIME'));
    } catch {
      Alert.alert(a.title, t('search.openError'));
    } finally {
      setOpening(null);
    }
  };

  const jump = (index: number) => {
    listRef.current?.scrollToLocation({ sectionIndex: index, itemIndex: 0, viewOffset: 0, animated: true });
  };

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + S.sm }}>
      <ScreenHeader title={t('calendar.title')} />
      <Txt v="small" style={{ paddingHorizontal: S.lg, marginTop: -4, marginBottom: S.md }}>{t('calendar.subtitle')}</Txt>

      <ScrollView horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0 }} contentContainerStyle={styles.chips}>
        <FilterChip icon="bookmark" label={`${t('calendar.onlyMine')}${items ? ` · ${mineCount}` : ''}`} selected={onlyMine} onPress={() => setOnlyMine((v) => !v)} />
        <View style={styles.sep} />
        {sections.map((d, i) => (
          <FilterChip key={d.key} label={d.short} selected={false} onPress={() => jump(i)} />
        ))}
      </ScrollView>

      {failed ? (
        <ErrorState onRetry={() => setAttempt((n) => n + 1)} />
      ) : !items ? (
        <LoadingView />
      ) : onlyMine && mineCount === 0 ? (
        <StateView icon="calendar-outline" title={t('calendar.emptyMine')} />
      ) : (
        <SectionList
          ref={listRef}
          sections={sections}
          keyExtractor={(a) => String(a.id)}
          stickySectionHeadersEnabled
          contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl }}
          onScrollToIndexFailed={() => {}}
          renderSectionHeader={({ section }) => (
            <View style={styles.dayHeader}>
              <Txt v="section" style={{ fontSize: 15 }}>{section.title}</Txt>
              <Txt v="small" style={{ fontSize: 12 }}>{section.data.length}</Txt>
            </View>
          )}
          renderSectionFooter={({ section }) =>
            section.data.length === 0 ? <Txt v="small" style={{ paddingHorizontal: S.lg, paddingBottom: S.md }}>{t('calendar.empty')}</Txt> : null
          }
          renderItem={({ item: a }) => {
            const mine = isMine(a);
            const aired = a.airingAt * 1000 < now;
            return (
              <Press
                onPress={() => open(a)}
                style={[styles.row, mine && styles.rowMine]}
                accessibilityRole="button"
                accessibilityLabel={`${a.title}, ${t('calendar.episode', { n: a.episode })}${mine ? `, ${t('calendar.inMyList')}` : ''}`}>
                <Txt v="label" style={[styles.time, aired && { color: C.text2 }]}>
                  {new Date(a.airingAt * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' })}
                </Txt>
                <Cover palette={palette(a.color)} image={a.image} width={44} height={60} radius={8} />
                <View style={{ flex: 1, gap: 3 }}>
                  <Txt v="label" numberOfLines={2} style={{ fontSize: 14 }}>{a.title}</Txt>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <Txt v="small" style={{ fontSize: 12 }}>{t('calendar.episode', { n: a.episode })}</Txt>
                    {aired && <Txt v="small" color={C.success} style={{ fontSize: 12 }}>· {t('calendar.aired')}</Txt>}
                  </View>
                  {mine && (
                    <View style={styles.mineTag}>
                      <Ionicons name="bookmark" size={10} color={C.accentText} />
                      <Txt v="caption" color={C.accentText} style={{ fontSize: 9 }}>{t('calendar.inMyList')}</Txt>
                    </View>
                  )}
                </View>
                {opening === a.id ? <ActivityIndicator color={C.text2} /> : <Ionicons name="chevron-forward" size={16} color={C.text2} />}
              </Press>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chips: { paddingHorizontal: S.lg, gap: S.sm, alignItems: 'center', paddingBottom: S.md },
  sep: { width: 1, height: 20, backgroundColor: C.border, marginHorizontal: 2 },
  dayHeader: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center',
    paddingHorizontal: S.lg, paddingVertical: 10, backgroundColor: C.bg,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, marginHorizontal: S.lg, marginVertical: 5,
    padding: 8, borderRadius: R.card, borderCurve: 'continuous', borderWidth: 1, borderColor: 'transparent',
  },
  rowMine: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  time: { width: 46, fontSize: 13, ...F.bold, fontVariant: ['tabular-nums'] },
  mineTag: { flexDirection: 'row', alignItems: 'center', gap: 4 },
});
