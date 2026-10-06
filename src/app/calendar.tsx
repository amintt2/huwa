// Weekly release calendar (AniList airing schedule, converted to the device's time zone).
// One day at a time, big posters in a two-column grid, like the planning pages fans already use.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Alert, AppState, FlatList, ScrollView, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SkeletonPosters } from '@/components/feedback';
import { BAR_H, LargeTitle, NavBar } from '@/components/screen';
import { ErrorState, FilterChip, StateView } from '@/components/states';
import { Cover, Press, Txt } from '@/components/ui';
import { palette } from '@/data/anilist';
import { fetchAiring, openMedia, type AiringItem } from '@/data/anilist-api';
import { useLocale, useT } from '@/i18n';
import { useLists } from '@/store/lists';
import { useStore } from '@/store/store';
import { C, R, S, SHADOW } from '@/theme/tokens';

const DAY = 86_400_000;
const GAP = 12;
/** Pills and badges sit on fixed-size art or in a strip: grow with Dynamic Type, within reason. */
const PILL_SCALE = 1.35;
const TAB_SCALE = 1.6;

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** "dans 1 h 20" / "dans 12 min". */
function countdown(ms: number, t: ReturnType<typeof useT>) {
  const m = Math.max(1, Math.round(ms / 60_000));
  const h = Math.floor(m / 60);
  return t('calendar.in', { time: h ? `${h} h ${String(m % 60).padStart(2, '0')}` : `${m} min` });
}

/** Calendar days between local midnight `today` and the local day of `at` (DST-safe). */
function dayIndex(today: number, at: number) {
  const a = new Date(today);
  const b = new Date(at);
  return Math.round((Date.UTC(b.getFullYear(), b.getMonth(), b.getDate()) - Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())) / 86_400_000);
}

export default function Calendar() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const t = useT();
  const locale = useLocale();
  const myList = useStore((s) => s.myList);
  const statuses = useLists((s) => s.status);

  const [items, setItems] = useState<AiringItem[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [onlyMine, setOnlyMine] = useState(false);
  const [opening, setOpening] = useState<number | null>(null);
  const [today, setToday] = useState(startOfToday);
  const [day, setDay] = useState(0);
  const tabsRef = useRef<ScrollView>(null);
  const tabFrames = useRef<Record<number, { x: number; width: number }>>({});
  /** Keep the selected day centered in the strip (also the initial one once laid out). */
  const reveal = (i: number, animated = true) => {
    const f = tabFrames.current[i];
    if (!f) return;
    tabsRef.current?.scrollTo({ x: Math.max(0, f.x + f.width / 2 - width / 2), animated });
  };
  const selectDay = (i: number) => {
    setDay(i);
    reveal(i);
  };
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const ctrl = new AbortController();
    fetchAiring(Math.floor(today / 1000), Math.floor((today + 7 * DAY) / 1000), ctrl.signal)
      .then((list) => {
        setItems(list);
        setFailed(false);
      })
      .catch(() => {
        if (!ctrl.signal.aborted) setFailed(true);
      });
    return () => ctrl.abort();
  }, [today, attempt]);

  // Keeps "Diffusé" badges and the countdown current while the page stays open, and moves
  // "Aujourd’hui" past midnight (also when coming back to the app the next morning). The selected
  // tab keeps showing the same date.
  useEffect(() => {
    let shown = startOfToday();
    const tick = () => {
      setNow(Date.now());
      const fresh = startOfToday();
      if (fresh === shown) return;
      const shift = dayIndex(shown, fresh);
      shown = fresh;
      setToday(fresh);
      setDay((d) => Math.max(0, d - shift));
    };
    const id = setInterval(tick, 30_000);
    const sub = AppState.addEventListener('change', (s) => s === 'active' && tick());
    return () => {
      clearInterval(id);
      sub.remove();
    };
  }, []);

  /** Series the user follows: "Ma liste" + anything marked "En cours" / "À voir". */
  const followed = useMemo(() => {
    const ids = new Set(myList);
    for (const [id, st] of Object.entries(statuses)) if (st === 'watching' || st === 'planned') ids.add(id);
    return ids;
  }, [myList, statuses]);
  const isMine = (a: AiringItem) => followed.has(a.seriesId ?? `al${a.anilistId}`);

  const days = useMemo(() => {
    const list = Array.from({ length: 7 }, (_, i) => {
      // Calendar days, not 24 h steps: DST weeks have a 23 h / 25 h day.
      const base = new Date(today);
      const date = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      return {
        label: i === 0 ? t('calendar.today') : i === 1 ? t('calendar.tomorrow') : date.toLocaleDateString(locale, { weekday: 'long' }),
        date: date.toLocaleDateString(locale, { day: 'numeric', month: 'short' }),
        data: [] as AiringItem[],
      };
    });
    for (const a of items ?? []) {
      if (onlyMine && !followed.has(a.seriesId ?? `al${a.anilistId}`)) continue;
      const i = dayIndex(today, a.airingAt * 1000);
      if (i >= 0 && i < 7) list[i].data.push(a);
    }
    for (const d of list) d.data.sort((a, b) => a.airingAt - b.airingAt || (b.popularity ?? 0) - (a.popularity ?? 0));
    return list;
  }, [items, onlyMine, followed, today, locale, t]);

  const mineCount = (items ?? []).filter(isMine).length;
  const selected = days[day];
  // Next release still to come today: followed series first, else the most popular soonest one.
  const next = useMemo(() => {
    if (day !== 0) return null;
    const upcoming = selected.data.filter((a) => a.airingAt * 1000 > now);
    return upcoming.find(isMine) ?? upcoming[0] ?? null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [day, selected, now, followed]);

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

  const cardW = Math.floor((width - S.lg * 2 - GAP) / 2);
  const time = (a: AiringItem) => new Date(a.airingAt * 1000).toLocaleTimeString(locale, { hour: '2-digit', minute: '2-digit' });

  const header = (
    <View style={{ gap: S.lg, paddingBottom: S.lg }}>
      {next && (
        <Press onPress={() => open(next)} style={styles.next} accessibilityRole="button"
          accessibilityLabel={`${t('calendar.next')} : ${next.title}, ${t('calendar.episode', { n: next.episode })}, ${countdown(next.airingAt * 1000 - now, t)}`}>
          <Cover palette={palette(next.color)} image={next.image} width={64} height={92} radius={10} />
          {/* The countdown sits in the text column: beside it, it squeezed the title to a few letters. */}
          <View style={{ flex: 1, minWidth: 0, gap: 4, alignItems: 'flex-start' }}>
            <Txt v="caption" color={C.accentText} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
              {t('calendar.next')}
            </Txt>
            <Txt v="label" numberOfLines={2} style={{ fontSize: 16 }}>{next.title}</Txt>
            <Txt v="small" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8}>
              {t('calendar.episode', { n: next.episode })} · {time(next)}
            </Txt>
            <View style={styles.countdown}>
              <Ionicons name="time-outline" size={13} color={C.white} />
              <Txt v="label" color={C.white} numberOfLines={1} maxFontSizeMultiplier={PILL_SCALE}
                style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>
                {countdown(next.airingAt * 1000 - now, t)}
              </Txt>
            </View>
          </View>
        </Press>
      )}
      <View style={{ flexDirection: 'row', alignItems: 'baseline', justifyContent: 'space-between', gap: S.md }}>
        <Txt v="section" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}
          style={{ fontSize: 20, textTransform: 'capitalize', flexShrink: 1 }}>
          {selected.label}
        </Txt>
        <Txt v="small" numberOfLines={1}>{t('calendar.count', { n: selected.data.length })}</Txt>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingTop: insets.top + BAR_H }}>
      <LargeTitle title={t('calendar.title')} subtitle={t('calendar.subtitle')} style={{ paddingBottom: S.md }} />

      {/* flexShrink 0: the list below must not squeeze the strip (it clipped the dates). */}
      <ScrollView ref={tabsRef} horizontal showsHorizontalScrollIndicator={false} style={{ flexGrow: 0, flexShrink: 0 }}
        contentContainerStyle={styles.tabs}>
        {days.map((d, i) => {
          const on = i === day;
          return (
            <Press key={`${i}-${d.date}`} onPress={() => selectDay(i)} accessibilityRole="tab" accessibilityState={{ selected: on }}
              accessibilityLabel={`${d.label}, ${d.date}${items ? `, ${t('calendar.count', { n: d.data.length })}` : ''}`}
              onLayout={(e) => {
                tabFrames.current[i] = e.nativeEvent.layout;
                if (i === day) reveal(i, false);
              }}
              style={[styles.tab, on && styles.tabOn]}>
              <Txt v="label" numberOfLines={1} maxFontSizeMultiplier={TAB_SCALE} color={on ? C.white : C.text}
                style={{ fontSize: 14, textTransform: 'capitalize' }}>
                {d.label}
              </Txt>
              <Txt v="small" numberOfLines={1} maxFontSizeMultiplier={TAB_SCALE} color={on ? 'rgba(255,255,255,0.8)' : C.text2}
                style={{ fontSize: 12, fontVariant: ['tabular-nums'] }}>
                {d.date}{items ? ` · ${d.data.length}` : ''}
              </Txt>
            </Press>
          );
        })}
      </ScrollView>

      <View style={styles.filters}>
        <FilterChip icon="bookmark" label={`${t('calendar.onlyMine')}${items ? ` · ${mineCount}` : ''}`} selected={onlyMine} onPress={() => setOnlyMine((v) => !v)} />
      </View>

      {failed ? (
        <ErrorState onRetry={() => setAttempt((n) => n + 1)} />
      ) : !items ? (
        <View style={{ paddingHorizontal: S.lg }}>
          <SkeletonPosters count={4} width={cardW} height={Math.round(cardW * 1.45)} gap={GAP} />
        </View>
      ) : onlyMine && mineCount === 0 ? (
        <StateView icon="calendar-outline" title={t('calendar.emptyMine')} />
      ) : (
        <FlatList
          key={day}
          data={selected.data}
          keyExtractor={(a) => String(a.id)}
          numColumns={2}
          columnWrapperStyle={{ gap: GAP }}
          contentContainerStyle={{ paddingHorizontal: S.lg, paddingBottom: insets.bottom + S.xxl, gap: S.lg }}
          ListHeaderComponent={header}
          ListEmptyComponent={<Txt v="small">{t('calendar.empty')}</Txt>}
          renderItem={({ item: a }) => {
            const mine = isMine(a);
            const aired = a.airingAt * 1000 < now;
            const first = a.episode === 1;
            const last = !!a.episodes && a.episode === a.episodes;
            return (
              <Press onPress={() => open(a)} style={{ width: cardW, gap: 8 }} accessibilityRole="button"
                accessibilityLabel={`${a.title}, ${t('calendar.episode', { n: a.episode })}, ${time(a)}${mine ? `, ${t('calendar.inMyList')}` : ''}`}>
                <View style={[styles.poster, mine && styles.posterMine]}>
                  <Cover palette={palette(a.color)} image={a.image} width={cardW} height={Math.round(cardW * 1.45)} radius={R.card} />
                  <View style={[styles.pill, styles.timePill, aired && { backgroundColor: 'rgba(12,17,28,0.85)' }]}>
                    <Ionicons name={aired ? 'checkmark' : 'time-outline'} size={12} color={aired ? C.success : C.white} />
                    <Txt v="label" color={C.white} numberOfLines={1} maxFontSizeMultiplier={PILL_SCALE}
                      style={{ fontSize: 13, fontVariant: ['tabular-nums'] }}>{time(a)}</Txt>
                  </View>
                  {mine && (
                    <View style={[styles.pill, styles.mine]}>
                      <Ionicons name="bookmark" size={12} color={C.white} />
                    </View>
                  )}
                  <View style={styles.bottomBadges}>
                    <View style={[styles.pill, { backgroundColor: 'rgba(5,7,13,0.82)' }]}>
                      <Txt v="label" color={C.white} numberOfLines={1} maxFontSizeMultiplier={PILL_SCALE} style={{ fontSize: 12 }}>
                        {t('calendar.ep', { n: a.episode })}
                      </Txt>
                    </View>
                    {(first || last) && (
                      <View style={[styles.pill, { backgroundColor: first ? C.accent : 'rgba(5,7,13,0.82)' }]}>
                        <Txt v="caption" color={first ? C.white : C.star} numberOfLines={1} maxFontSizeMultiplier={PILL_SCALE} style={{ fontSize: 10 }}>
                          {first ? t('calendar.new') : t('calendar.final')}
                        </Txt>
                      </View>
                    )}
                  </View>
                  {opening === a.id && (
                    <View style={styles.loading}><ActivityIndicator color={C.white} /></View>
                  )}
                </View>
                <Txt v="label" numberOfLines={2} style={{ fontSize: 14, lineHeight: 18 }}>{a.title}</Txt>
              </Press>
            );
          }}
        />
      )}
      <NavBar />
    </View>
  );
}

const styles = StyleSheet.create({
  tabs: { paddingHorizontal: S.lg, gap: S.sm, paddingBottom: S.md, alignItems: 'stretch' },
  tab: {
    minWidth: 92, minHeight: 50, justifyContent: 'center', paddingVertical: 8, paddingHorizontal: 14, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, gap: 1, boxShadow: SHADOW.inset,
  },
  tabOn: { backgroundColor: C.accent, borderColor: C.accent, boxShadow: `${SHADOW.primary}, ${SHADOW.insetStrong}` },
  filters: { flexDirection: 'row', paddingHorizontal: S.lg, paddingBottom: S.lg },
  next: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: '#0F1A33', borderWidth: 1, borderColor: C.accentLine, boxShadow: `${SHADOW.raised}, ${SHADOW.inset}`,
  },
  countdown: {
    flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2, maxWidth: '100%',
    paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.pill, backgroundColor: C.accent, boxShadow: SHADOW.insetStrong,
  },
  poster: { borderRadius: R.card, borderCurve: 'continuous', overflow: 'hidden' },
  posterMine: { borderWidth: 2, borderColor: C.accentText },
  pill: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingVertical: 4, borderRadius: R.pill },
  timePill: { position: 'absolute', top: 8, left: 8, maxWidth: '70%', backgroundColor: 'rgba(47,107,235,0.92)' },
  mine: { position: 'absolute', top: 8, right: 8, backgroundColor: 'rgba(5,7,13,0.82)', paddingHorizontal: 6 },
  bottomBadges: { position: 'absolute', left: 8, bottom: 8, right: 8, flexDirection: 'row', gap: 6, flexWrap: 'wrap' },
  loading: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(0,0,0,0.35)' },
});
