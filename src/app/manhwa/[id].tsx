import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { BridgeToAnime } from '@/components/bridge';
import { Button, Chip, Cover, IconButton, Press, Progress, Txt } from '@/components/ui';
import { episodeForChapter } from '@/data/bridge';
import { getSeries, type Chapter } from '@/data/catalog';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, S } from '@/theme/tokens';

export default function ManhwaDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  const series = getSeries(id);
  const chapters = useStore((s) => s.chapters);
  const episodes = useStore((s) => s.episodes);
  const inList = useStore((s) => s.myList.includes(id));
  const [newestFirst, setNewestFirst] = useState(true);

  const list = useMemo(() => {
    const all = series?.manhwa?.chapters ?? [];
    return newestFirst ? [...all].reverse() : all;
  }, [series, newestFirst]);

  if (!series?.manhwa) return <Txt style={{ padding: S.xl }}>Manhwa introuvable.</Txt>;
  const all = series.manhwa.chapters;

  // Resume: chapter in progress, else first unread chapter after what you read or watched.
  const inProgress = all.find((c) => chapters[c.id] && !chapters[c.id].done);
  const lastRead = [...all].reverse().find((c) => chapters[c.id]?.done)?.number ?? 0;
  const lastWatched = Math.max(0, ...(series.anime?.episodes.filter((e) => episodes[e.id]?.done).map((e) => e.chapters[1]) ?? []));
  const resume = inProgress ?? all[Math.min(all.length - 1, Math.max(lastRead, lastWatched))];

  const renderRow = ({ item: c }: { item: Chapter }) => {
    const p = chapters[c.id];
    const ep = episodeForChapter(series, c.number);
    const seenInAnime = !!ep && !!episodes[ep.id]?.done;
    const muted = p?.done || seenInAnime;
    return (
      <Press onPress={() => router.push(`/read/${c.id}`)} style={styles.row} accessibilityLabel={`Chapitre ${c.number}`}>
        <Cover palette={series.palette} image={series.image} width={56} height={56} radius={10} dim={muted} />
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
            <Txt v="label" color={muted ? C.text2 : C.text}>Chapitre {c.number}</Txt>
            {c.releasedDaysAgo === 0 && (
              <View style={styles.new}><Txt v="caption" color={C.onAccent} style={{ fontSize: 9 }}>NOUVEAU</Txt></View>
            )}
            {ep && seenInAnime && <Chip kind="anime" label={`VU EN ANIME · ÉP. ${ep.number}`} />}
          </View>
          {p && !p.done ? (
            <>
              <Txt v="small" color={C.accent} style={{ ...F.semibold }}>En cours · {Math.round(p.ratio * 100)} %</Txt>
              <Progress value={p.ratio} color={C.accent} />
            </>
          ) : (
            <Txt v="small">
              {p?.done ? 'Lu' : c.releasedDaysAgo === 0 ? 'Aujourd’hui' : `il y a ${c.releasedDaysAgo} j`}
              {ep && !seenInAnime ? ` · adapté dans l’ép. ${ep.number}` : ''}
            </Txt>
          )}
        </View>
      </Press>
    );
  };

  return (
    <FlatList
      style={{ flex: 1, backgroundColor: C.bg }}
      data={list}
      keyExtractor={(c) => c.id}
      renderItem={renderRow}
      initialNumToRender={12}
      contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl, gap: S.md }}
      ListHeaderComponent={
        <View style={{ gap: S.lg, paddingBottom: S.xs }}>
          <View style={{ height: 350 }}>
            <Cover palette={series.palette} image={series.image} height={350} radius={0} dim style={StyleSheet.absoluteFill} />
            <View style={[styles.nav, { top: insets.top + S.sm }]}>
              <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
            </View>
            <View style={styles.info}>
              <Cover palette={series.palette} image={series.image} width={128} height={190} radius={14} />
              <View style={{ flex: 1, gap: S.sm }}>
                <Chip kind="manhwa" />
                <Txt v="title" style={{ fontSize: 24, lineHeight: 28 }}>{series.title}</Txt>
                <Txt v="small" style={{ fontSize: 13 }}>{series.author}</Txt>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                  <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: series.status === 'ongoing' ? C.success : C.text2 }} />
                  <Txt v="small">{series.status === 'ongoing' ? 'En cours' : 'Terminé'} · {all.length} ch.</Txt>
                </View>
              </View>
            </View>
          </View>

          <View style={{ paddingHorizontal: S.lg, gap: S.lg }}>
            <View style={{ flexDirection: 'row', gap: 10 }}>
              <Button
                style={{ flex: 1 }}
                color={C.accent}
                textColor={C.onAccent}
                label={inProgress || lastRead ? `Continuer · Ch. ${resume.number}` : `Lire · Ch. ${resume.number}`}
                onPress={() => router.push(`/read/${resume.id}`)}
              />
              <Press onPress={() => toggleMyList(series.id)} style={styles.square} accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'}>
                <Ionicons name={inList ? 'checkmark' : 'add'} size={24} color={C.text} />
              </Press>
            </View>
            <Txt v="body">{series.synopsis}</Txt>
            {series.anime && <BridgeToAnime series={series} />}
            <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}>
              <Txt v="section" style={{ fontSize: 17 }}>{all.length} chapitres</Txt>
              <Pressable onPress={() => setNewestFirst((v) => !v)} hitSlop={10} style={{ flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 44 }}>
                <Txt v="small" style={{ fontSize: 13, ...F.medium }}>{newestFirst ? 'Plus récents' : 'Plus anciens'}</Txt>
                <Ionicons name="swap-vertical" size={14} color={C.text2} />
              </Pressable>
            </View>
          </View>
        </View>
      }
    />
  );
}

const styles = StyleSheet.create({
  nav: { position: 'absolute', left: S.lg },
  info: { position: 'absolute', left: S.lg, right: S.lg, bottom: S.md, flexDirection: 'row', alignItems: 'flex-end', gap: S.lg },
  square: { width: 52, height: 52, borderRadius: 16, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.lg },
  new: { paddingVertical: 2, paddingHorizontal: 6, borderRadius: 5, backgroundColor: C.accent },
});
