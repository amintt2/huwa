// "Bridge" UI: everything that links an anime to its manhwa (and back).
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { StyleSheet, View } from 'react-native';

import { animeEndChapter, approx, continuationChapter, resumeEpisode } from '@/data/bridge';
import type { Series } from '@/data/catalog';
import { useStore } from '@/store/store';
import { BRIDGE_SOFT, C, R, S } from '@/theme/tokens';

import { Button, Chip, Cover, Press, Txt } from './ui';

function Frame({ children, reverse }: { children: React.ReactNode; reverse?: boolean }) {
  return (
    <LinearGradient
      colors={reverse ? [BRIDGE_SOFT[1], BRIDGE_SOFT[0]] : BRIDGE_SOFT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={[styles.frame, { borderLeftColor: reverse ? C.accent : C.accent, borderRightColor: reverse ? C.accent : C.accent }]}>
      {children}
    </LinearGradient>
  );
}

/** On the anime page: where the manhwa picks up. */
export function BridgeToManhwa({ series }: { series: Series }) {
  const next = continuationChapter(series);
  const eps = series.anime!.episodes;
  const total = series.manhwa!.chapters.length;
  const end = animeEndChapter(series);
  if (!next) return null;
  return (
    <Frame>
      <Chip kind="bridge" label="ANIME → MANHWA" />
      <Txt v="section" style={{ fontSize: 17 }}>L’anime s’arrête à l’épisode {eps.length}</Txt>
      <Txt v="body" style={{ fontSize: 13, lineHeight: 19 }}>
        {series.estimated ? `La suite commence vers le chapitre ${next.number} (estimation).` : `La suite commence au chapitre ${next.number}.`} Ta progression est synchronisée entre les deux.
      </Txt>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 3 }}>
          <View style={[styles.seg, { flex: end, backgroundColor: C.accent }]} />
          <View style={[styles.seg, { flex: total - end, backgroundColor: C.accent }]} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Txt v="small" color={C.accentText} style={styles.segLabel}>Ép. 1–{eps.length} = {approx(series)}Ch. 1–{end}</Txt>
          <Txt v="small" color={C.accentText} style={styles.segLabel}>{approx(series)}Ch. {next.number} → {total}</Txt>
        </View>
      </View>
      <Button
        label={`Continuer au chapitre ${next.number}`}
        icon="arrow-forward"
        color={C.accent}
        textColor={C.onAccent}
        onPress={() => router.push(`/read/${next.id}`)}
        style={{ paddingVertical: 12, borderRadius: R.card, flexDirection: 'row-reverse' }}
      />
    </Frame>
  );
}

/** On the manhwa page: the anime adaptation and how far you got. */
export function BridgeToAnime({ series }: { series: Series }) {
  const episodes = useStore((s) => s.episodes);
  const eps = series.anime!.episodes;
  const watched = eps.filter((e) => episodes[e.id]?.done).length;
  const resume = resumeEpisode(series, episodes) ?? eps[0];
  return (
    <Press onPress={() => router.push(`/anime/${series.id}`)} accessibilityLabel="Voir l’anime">
      <Frame reverse>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
          <Cover palette={series.palette} image={series.image} width={64} height={64} radius={12}>
            <View style={styles.play}>
              <Ionicons name="play" size={12} color={C.white} />
            </View>
          </Cover>
          <View style={{ flex: 1, gap: 4 }}>
            <Chip kind="anime" label="AUSSI EN ANIME" />
            <Txt v="label">{approx(series)}Ch. 1–{animeEndChapter(series)} adaptés en {eps.length} épisodes</Txt>
            <Txt v="small">
              {watched > 0 ? `Tu as vu ${watched}/${eps.length} · reprendre ép. ${resume.number}` : 'Pas encore commencé'}
            </Txt>
          </View>
          <Ionicons name="arrow-forward" size={20} color={C.accentText} />
        </View>
      </Frame>
    </Press>
  );
}

/** Thin strip under an episode: "this episode = chapters X–Y → read on". */
export function EpisodeBridgeStrip({ from, to, nextChapterId, estimated }: { from: number; to: number; nextChapterId?: string; estimated?: boolean }) {
  const a = estimated ? '≈ ' : '';
  return (
    <Frame>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 13 }}>Cet épisode adapte les {a}ch. {from === to ? from : `${from}–${to}`}</Txt>
          <Txt v="small">{nextChapterId ? `Le manhwa va plus loin, dès le ${a}ch. ${to + 1}.` : 'Tu es à jour avec le manhwa.'}</Txt>
        </View>
        {nextChapterId && (
          <Button small label="Lire" color={C.accent} textColor={C.onAccent} onPress={() => router.push(`/read/${nextChapterId}`)} />
        )}
      </View>
    </Frame>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: S.lg, gap: 10, borderRadius: 20, borderWidth: 1.5,
    borderTopColor: C.border, borderBottomColor: C.border,
  },
  seg: { height: 6, borderRadius: 3 },
  segLabel: { fontSize: 11, fontWeight: '600' },
  play: {
    position: 'absolute', left: 19, top: 19, width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(10,10,15,0.6)', alignItems: 'center', justifyContent: 'center',
  },
});
