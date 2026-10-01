import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { traceTap } from '@/addons/timing';
import { BridgeToManhwa } from '@/components/bridge';
import { ListsButton } from '@/components/lists';
import { PRIORITY, usePresearch } from '@/components/presearch';
import { Button, Chip, Cover, IconButton, Press, Progress, Txt } from '@/components/ui';
import { approxEp, chapterRangeLabel, resumeEpisode } from '@/data/bridge';
import { episodeLabel, getSeries, useCatalog, type Series } from '@/data/catalog';
import { useSeasonNumber } from '@/data/franchise';
import { useMappingSync } from '@/data/mapping-sync';
import { useThread } from '@/store/derived';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, S } from '@/theme/tokens';

export default function AnimeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const insets = useSafeAreaInsets();
  // Chapter ranges change when earlier seasons or community corrections arrive.
  useCatalog();
  const series = getSeries(id);
  useMappingSync(series);
  const progress = useStore((s) => s.episodes);
  const inList = useStore((s) => s.myList.includes(id));
  const commentCount = useThread(`series:${id}`).length;
  // The episode "Commencer / Reprendre" opens: its sources are searched (and on Wi-Fi buffered)
  // while the page is read.
  const target = series?.anime ? resumeEpisode(series, progress) ?? series.anime.episodes[0] : undefined;
  usePresearch(
    'detail',
    series && target
      ? { seriesId: series.id, episodeId: target.id, episode: target.number, meta: { title: series.title, artist: episodeLabel(target), artwork: series.image } }
      : null,
    PRIORITY.detail,
    { dwellMs: 300 },
  );
  if (!series?.anime) return <Txt style={{ padding: S.xl }}>Anime introuvable.</Txt>;

  const eps = series.anime.episodes;
  const resume = resumeEpisode(series, progress) ?? eps[0];
  const started = eps.some((e) => progress[e.id]);

  return (
    <ScrollView style={{ flex: 1, backgroundColor: C.bg }} contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl }}>
      <Cover palette={series.palette} image={series.image} height={340} radius={0} shade>
        <View style={[styles.nav, { top: insets.top + S.sm }]}>
          <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
        </View>
        <View style={styles.heroText}>
          <View style={{ flexDirection: 'row', gap: 6 }}>
            <Chip kind="anime" />
            <SeasonChip series={series} />
          </View>
          <Txt v="display" style={{ fontSize: 32 }}>{series.title}</Txt>
          <Txt v="small" style={{ fontSize: 13, ...F.medium }}>
            {series.year} · {eps.length} épisodes · {series.genres.join(', ')} · {series.rating}
          </Txt>
        </View>
      </Cover>

      <View style={{ padding: S.lg, gap: S.lg }}>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Button
            style={{ flex: 1 }}
            icon="play"
            label={started ? `Reprendre Ép. ${resume.number}` : 'Commencer'}
            onPress={() => {
              traceTap(resume.id);
              router.push(`/watch/${resume.id}`);
            }}
          />
          <Press onPress={() => toggleMyList(series.id)} style={styles.square} accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'}>
            <Ionicons name={inList ? 'checkmark' : 'add'} size={24} color={C.text} />
          </Press>
          <ListsButton seriesId={series.id} />
        </View>

        <Txt v="body">{series.synopsis}</Txt>

        {series.manhwa && <BridgeToManhwa series={series} />}

        <View style={{ flexDirection: 'row', gap: 22, alignItems: 'center' }}>
          <View style={styles.tabOn}><Txt v="label">Épisodes</Txt></View>
          <Press onPress={() => router.push({ pathname: '/comments', params: { target: `series:${id}`, kind: 'anime' } })}>
            <Txt v="label" color={C.text2} style={{ ...F.medium, paddingBottom: 8 }}>Commentaires {commentCount}</Txt>
          </Press>
        </View>

        {eps.map((e) => {
          const p = progress[e.id];
          const ratio = p ? p.position / p.duration : 0;
          return (
            <Press key={e.id} onPress={() => router.push(`/watch/${e.id}`)} style={styles.row} accessibilityLabel={episodeLabel(e)}>
              <Cover palette={series.palette} image={series.image} width={124} height={70} radius={10} dim={p?.done}>
                <View style={styles.thumbPlay}>
                  <Ionicons name={p?.done ? 'checkmark' : 'play'} size={12} color={C.white} />
                </View>
                {ratio > 0 && !p?.done && (
                  <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
                    <Progress value={ratio} color={C.accentText} track="rgba(255,255,255,0.25)" />
                  </View>
                )}
              </Cover>
              <View style={{ flex: 1, gap: 4 }}>
                <Txt v="label" numberOfLines={1} color={p?.done ? C.text2 : C.text}>{episodeLabel(e)}</Txt>
                <Txt v="small">
                  {e.durationMin} min{series.manhwa ? ` · adapte les ${approxEp(series, e)}${chapterRangeLabel(e)}` : ''}
                </Txt>
              </View>
            </Press>
          );
        })}
      </View>
    </ScrollView>
  );
}

/** "SAISON 2" once the franchise is known (also starts resolving it, which shifts the chapters). */
function SeasonChip({ series }: { series: Series }) {
  const season = useSeasonNumber(series);
  if (series.status === 'completed' && (season ?? 1) === 1) return <Chip kind="neutral" label="TERMINÉ" />;
  return <Chip kind="neutral" label={`SAISON ${season ?? 1}`} />;
}

const styles = StyleSheet.create({
  nav: { position: 'absolute', left: S.lg },
  heroText: { position: 'absolute', left: S.lg, right: S.lg, bottom: S.lg, gap: S.sm },
  square: { width: 52, height: 52, borderRadius: 16, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center' },
  tabOn: { paddingBottom: 8, borderBottomWidth: 3, borderBottomColor: C.accent },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  thumbPlay: {
    position: 'absolute', left: 48, top: 21, width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(10,10,15,0.6)', alignItems: 'center', justifyContent: 'center',
  },
});
