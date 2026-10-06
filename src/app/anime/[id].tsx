import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedScrollHandler, useSharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { traceTap } from '@/addons/timing';
import { BridgeToManhwa } from '@/components/bridge';
import { DownloadSheet, EpisodeDownloadButton } from '@/components/downloads/episode-download';
import { ListsButton } from '@/components/lists';
import { isStoreBuild } from '@/config/channel';
import { PRIORITY, usePresearch } from '@/components/presearch';
import { DetailBackdrop, DetailNav, DetailTabs, Synopsis } from '@/components/detail';
import { SeasonButton, SeasonSheet, type FranchiseSeasons } from '@/components/season-picker';
import { ActionTile, Button, Chip, Cover, MetaLine, Press, Progress, Txt } from '@/components/ui';
import { approxEp, chapterRangeLabel, resumeEpisode } from '@/data/bridge';
import { episodeLabel, getSeries, useCatalog, type Episode, type Series } from '@/data/catalog';
import { useFranchiseSeasons, useSeasonNumber } from '@/data/franchise';
import { useMappingSync } from '@/data/mapping-sync';
import { enqueueEpisodes, getItem, useDownloadItems } from '@/downloads';
import { useThread } from '@/store/derived';
import { toggleMyList, useStore } from '@/store/store';
import { C, F, S, TABULAR } from '@/theme/tokens';

export default function AnimeDetail() {
  const { id } = useLocalSearchParams<{ id: string }>();
  useCatalog();
  const franchise = useFranchiseSeasons(getSeries(id));
  const [picking, setPicking] = useState(false);
  // Several seasons only: a lone season has nothing to pick.
  const multi = franchise && franchise.seasons.length > 1 ? franchise : undefined;
  return (
    <>
      {/* Keyed by id: switching season starts the page afresh (episode paging, presearch, sheets). */}
      <AnimeDetailPage key={id} id={id} franchise={multi} onSeasons={() => setPicking(true)} />
      {multi && (
        <SeasonSheet
          franchise={multi}
          visible={picking}
          onClose={() => setPicking(false)}
          onPick={(s) => {
            setPicking(false);
            // Same screen, new series: back still leaves the anime page (no stack of seasons).
            router.setParams({ id: s.id });
          }}
        />
      )}
    </>
  );
}

function AnimeDetailPage({ id, franchise, onSeasons }: { id: string; franchise?: FranchiseSeasons; onSeasons: () => void }) {
  const insets = useSafeAreaInsets();
  // Chapter ranges change when earlier seasons or community corrections arrive.
  useCatalog();
  const series = getSeries(id);
  useMappingSync(series);
  const progress = useStore((s) => s.episodes);
  const inList = useStore((s) => s.myList.includes(id));
  const commentCount = useThread(`series:${id}`).length;
  const downloads = useDownloadItems();
  const [dlFor, setDlFor] = useState<Episode | null>(null);
  const scrollY = useSharedValue(0);
  const onScroll = useAnimatedScrollHandler({ onScroll: (e) => { scrollY.set(e.contentOffset.y); } });
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
  // Long series (1000+ episodes): rows are rendered in pages instead of all at once; the first
  // page reaches past the episode to resume.
  const [limit, setLimit] = useState(() => {
    const i = target && series?.anime ? series.anime.episodes.indexOf(target) : 0;
    return Math.max(EPISODE_PAGE, i + 20);
  });
  if (!series?.anime) return <Txt style={{ padding: S.xl }}>Anime introuvable.</Txt>;

  const eps = series.anime.episodes;
  const resume = resumeEpisode(series, progress) ?? eps[0];
  const started = eps.some((e) => progress[e.id]);

  const resumeP = progress[resume.id];
  const resumeRatio = resumeP && !resumeP.done && resumeP.duration ? resumeP.position / resumeP.duration : 0;
  const openComments = () => router.push({ pathname: '/comments', params: { target: `series:${id}`, kind: 'anime' } });

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        contentInsetAdjustmentBehavior="never"
        showsVerticalScrollIndicator={false}
        contentContainerStyle={{ paddingBottom: insets.bottom + S.xxl }}>
        <DetailBackdrop series={series} scrollY={scrollY}>
          <Txt v="display" numberOfLines={3} style={styles.title}>{series.title}</Txt>
          <MetaLine
            items={[
              <View key="r" style={styles.rating}>
                <Ionicons name="star" size={12} color={C.star} />
                <Text style={styles.ratingText}>{String(series.rating).replace('.', ',')}</Text>
              </View>,
              String(series.year),
              `${eps.length} épisodes`,
              <SeasonChip key="s" series={series} onPress={franchise && onSeasons} />,
            ]}
          />
          <Txt v="small" color={C.text2} numberOfLines={1}>{series.genres.join(' · ')}</Txt>
        </DetailBackdrop>

        <View style={{ paddingHorizontal: S.lg, paddingTop: S.md, gap: S.lg }}>
          <View style={{ gap: S.sm }}>
            <Button
              large
              icon="play"
              label={started ? `Reprendre · Ép. ${resume.number}` : 'Commencer · Ép. 1'}
              onPress={() => {
                traceTap(resume.id);
                router.push(`/watch/${resume.id}`);
              }}
            />
            {resumeRatio > 0 && (
              <View style={styles.resumeRow}>
                <View style={{ flex: 1 }}><Progress value={resumeRatio} height={3} /></View>
                <Txt v="footnote" tabular>
                  {`Reste ${Math.max(1, Math.round((resumeP!.duration - resumeP!.position) / 60))} min`}
                </Txt>
              </View>
            )}
          </View>

          <View style={styles.tiles}>
            <ActionTile icon={inList ? 'checkmark' : 'add'} label="Ma liste" active={inList} onPress={() => toggleMyList(series.id)}
              accessibilityLabel={inList ? 'Retirer de ma liste' : 'Ajouter à ma liste'} />
            <ListsButton seriesId={series.id} tile />
            <ActionTile icon="chatbubble-outline" label={commentCount ? `Avis · ${commentCount}` : 'Avis'} onPress={openComments}
              accessibilityLabel={`Commentaires, ${commentCount}`} />
          </View>

          <Synopsis text={series.synopsis} />

          {series.manhwa && <BridgeToManhwa series={series} />}

          <DetailTabs
            tabs={[{ label: 'Épisodes', active: true }, { label: 'Commentaires', count: commentCount, onPress: openComments }]}
            right={franchise && <SeasonButton index={franchise.index} onPress={onSeasons} />}
          />

          {eps.slice(0, limit).map((e) => {
            const p = progress[e.id];
            const ratio = p ? p.position / p.duration : 0;
            const done = !!p?.done;
            const dl = downloads[e.id]?.status === 'done';
            const current = e.id === resume.id && started;
            return (
              <Press
                key={e.id}
                onPress={() => router.push(`/watch/${e.id}`)}
                // App Store flavor: no episode downloads (their sources are extensions).
                onLongPress={isStoreBuild ? undefined : () => setDlFor(e)}
                delayLongPress={350}
                scaleTo={0.98}
                style={styles.row}
                accessibilityLabel={`${episodeLabel(e)}${done ? ', vu' : ''}${dl ? ', téléchargé' : ''}`}
                accessibilityHint={isStoreBuild ? undefined : 'Appui long : options de téléchargement'}>
                <Cover palette={series.palette} image={series.image} width={136} height={77} radius={8} dim={done}>
                  <View style={[styles.thumbPlay, current && { backgroundColor: C.accent, borderColor: C.accent }]}>
                    <Ionicons name={done ? 'checkmark' : 'play'} size={13} color={C.white} style={done ? undefined : { marginLeft: 1.5 }} />
                  </View>
                  <View style={styles.duration}>
                    <Text style={styles.durationText}>{e.durationMin} min</Text>
                  </View>
                  {ratio > 0 && !done && (
                    <View style={{ position: 'absolute', left: 0, right: 0, bottom: 0 }}>
                      <Progress value={ratio} color={C.accentText} track="rgba(255,255,255,0.25)" />
                    </View>
                  )}
                </Cover>
                <View style={{ flex: 1, gap: 4 }}>
                  <Txt v="label" numberOfLines={2} color={done ? C.text2 : C.text}>{episodeLabel(e)}</Txt>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
                    {dl && <Ionicons name="arrow-down-circle" size={13} color={C.accentText} />}
                    <Txt v="footnote" numberOfLines={1} style={{ flexShrink: 1 }}>
                      {dl ? 'Téléchargé · ' : ''}
                      {series.manhwa ? `Adapte les ${approxEp(series, e)}${chapterRangeLabel(e)}` : `${e.durationMin} min`}
                    </Txt>
                  </View>
                </View>
                {!isStoreBuild && (
                  <EpisodeDownloadButton
                    episodeId={e.id}
                    onPress={() => (getItem(e.id) ? setDlFor(e) : enqueueEpisodes(series, e, 'one'))}
                    onLongPress={() => setDlFor(e)}
                  />
                )}
              </Press>
            );
          })}
          {eps.length > limit && (
            <Button
              variant="ghost"
              icon="chevron-down"
              label={`Afficher ${Math.min(EPISODE_PAGE, eps.length - limit)} épisodes de plus (${eps.length - limit} restants)`}
              onPress={() => setLimit((n) => n + EPISODE_PAGE)}
            />
          )}
        </View>
        {dlFor && <DownloadSheet series={series} episode={dlFor} visible onClose={() => setDlFor(null)} />}
      </Animated.ScrollView>
      <DetailNav title={series.title} scrollY={scrollY} />
    </View>
  );
}

/**
 * "SAISON 2" once the franchise is known (also starts resolving it, which shifts the chapters).
 * With several seasons it opens the season picker.
 */
function SeasonChip({ series, onPress }: { series: Series; onPress?: () => void }) {
  const season = useSeasonNumber(series);
  if (!onPress && series.status === 'completed' && (season ?? 1) === 1) return <Chip kind="neutral" label="Terminé" />;
  const chip = <Chip kind="neutral" label={`Saison ${season ?? 1}`} />;
  if (!onPress) return chip;
  return (
    <Press onPress={onPress} haptics="select" hitSlop={10} accessibilityRole="button"
      accessibilityLabel={`Saison ${season ?? 1}`} accessibilityHint="Choisir une autre saison">
      {chip}
    </Press>
  );
}

const EPISODE_PAGE = 60;

const styles = StyleSheet.create({
  title: { fontSize: 36, lineHeight: 40, letterSpacing: -1.1, ...F.black, textShadowColor: 'rgba(0,0,0,0.4)', textShadowRadius: 16 },
  rating: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  ratingText: { color: C.text, fontSize: 13, ...F.bold, ...TABULAR },
  resumeRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: 2 },
  tiles: { flexDirection: 'row', justifyContent: 'space-around', paddingVertical: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 77 },
  thumbPlay: {
    position: 'absolute', left: 54, top: 24, width: 28, height: 28, borderRadius: 14,
    backgroundColor: 'rgba(5,7,13,0.55)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.7)', alignItems: 'center', justifyContent: 'center',
  },
  duration: {
    position: 'absolute', right: 5, bottom: 6, paddingHorizontal: 5, paddingVertical: 2, borderRadius: 5, borderCurve: 'continuous',
    backgroundColor: 'rgba(5,7,13,0.78)',
  },
  durationText: { color: C.text, fontSize: 10, ...F.semibold, ...TABULAR },
});
