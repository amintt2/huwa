// "Bridge" UI: everything that links an anime to its manhwa (and back).
import Ionicons from '@expo/vector-icons/Ionicons';
import { LinearGradient } from 'expo-linear-gradient';
import { router } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';

import { animeEndChapter, animeStartChapter, approx, approxEp, continuationChapter, resumeEpisode } from '@/data/bridge';
import type { Episode, Series } from '@/data/catalog';
import { proposeCorrection } from '@/data/mapping-sync';
import { useSeasonState, type FieldState } from '@/data/mapping-store';
import { useStore } from '@/store/store';
import { BRIDGE_SOFT, C, R, S, SHADOW } from '@/theme/tokens';

import { Button, Chip, Cover, Press, Txt } from './ui';

function Frame({ children, reverse }: { children: React.ReactNode; reverse?: boolean }) {
  return (
    <LinearGradient
      colors={reverse ? [BRIDGE_SOFT[1], BRIDGE_SOFT[0]] : BRIDGE_SOFT}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 0 }}
      style={[styles.frame, { borderLeftColor: C.border, borderRightColor: C.border }]}>
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
  const start = animeStartChapter(series);
  if (!next) return null;
  return (
    <Frame>
      <Chip kind="bridge" label="Anime → Manhwa" />
      <Txt v="headline">L’anime s’arrête à l’épisode {eps.length}</Txt>
      <Txt v="body" style={{ fontSize: 13, lineHeight: 19 }}>
        {series.estimated ? `La suite commence vers le chapitre ${next.number} (estimation).` : `La suite commence au chapitre ${next.number}.`} Ta progression est synchronisée entre les deux.
      </Txt>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', gap: 3 }}>
          {start > 1 && <View style={[styles.seg, { flex: start - 1, backgroundColor: C.pill }]} />}
          <View style={[styles.seg, { flex: end - start + 1, backgroundColor: C.accent }]} />
          <View style={[styles.seg, { flex: total - end, backgroundColor: C.accent }]} />
        </View>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Txt v="small" color={C.accentText} style={styles.segLabel}>Ép. 1–{eps.length} = {approx(series)}Ch. {start}–{end}</Txt>
          <Txt v="small" color={C.accentText} style={styles.segLabel}>{approx(series)}Ch. {next.number} → {total}</Txt>
        </View>
      </View>
      <Button
        label={`Continuer au chapitre ${next.number}`}
        icon="arrow-forward"
        iconRight
        variant="soft"
        onPress={() => router.push(`/read/${next.id}`)}
        style={{ paddingVertical: 12, borderRadius: R.card, flexDirection: 'row-reverse' }}
      />
      <MappingProvenance series={series} />
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
            <Chip kind="anime" label="Aussi en anime" />
            <Txt v="label">{approx(series)}Ch. {animeStartChapter(series)}–{animeEndChapter(series)} adaptés en {eps.length} épisodes</Txt>
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
export function EpisodeBridgeStrip({ series, episode, nextChapterId }: { series: Series; episode: Episode; nextChapterId?: string }) {
  const a = approxEp(series, episode);
  const [from, to] = episode.chapters;
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
      <MappingProvenance series={series} episode={episode} />
    </Frame>
  );
}

const plural = (n: number, word: string) => `${n} ${word}${n > 1 ? 's' : ''}`;
const fieldKeyOf = (f: FieldState) => (f.from !== undefined ? `${f.from}-${f.to}` : `${f.to}`);

/**
 * Where the numbers come from ("≈ estimation", "proposé par la communauté", "vérifié"), with
 * "Corriger" (opens the correction sheet) and "Confirmer" on a pending community value.
 */
export function MappingProvenance({ series, episode }: { series: Series; episode?: Episode }) {
  const state = useSeasonState(series.id);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!series.mapping) return null;
  const field = episode ? state?.eps?.[episode.number] : state?.end;
  const estimated = episode ? (episode.estimated ?? series.estimated) : series.estimated;

  let label: string;
  let icon: 'checkmark-circle' | 'people' | 'analytics-outline' | 'book-outline';
  if (field?.verified) {
    label = `Vérifié par la communauté · ${plural(field.confirmations, 'confirmation')}`;
    icon = 'checkmark-circle';
  } else if (!estimated) {
    label = series.mapping.source === 'verified' ? 'Fin de saison vérifiée par la communauté' : 'Correspondance de la source';
    icon = series.mapping.source === 'verified' ? 'checkmark-circle' : 'book-outline';
  } else {
    label = series.mapping.source === 'verified' ? '≈ Estimation entre des bornes vérifiées' : '≈ Estimation';
    icon = 'analytics-outline';
  }
  const pending = field && !field.verified ? field : undefined;
  const confirmed = pending?.mine === (pending && fieldKeyOf(pending));

  const correct = () =>
    router.push({ pathname: '/mapping', params: episode ? { series: series.id, ep: String(episode.number) } : { series: series.id } });
  const confirm = async () => {
    if (!pending) return;
    setBusy(true);
    setError(undefined);
    try {
      await proposeCorrection(
        series,
        episode ? { field: 'ep', ep: episode.number, from: pending.from ?? pending.to, to: pending.to } : { field: 'end', to: pending.to },
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <View style={styles.provenance}>
      <View style={styles.provRow}>
        <Ionicons name={icon} size={14} color={field?.verified ? C.success : C.text2} />
        <Txt v="small" style={{ flex: 1, fontSize: 12 }} numberOfLines={2}>{label}</Txt>
        <Press onPress={correct} hitSlop={10} accessibilityRole="button" accessibilityLabel={episode ? 'Ce n’est pas ça ? Corriger' : 'Corriger la correspondance'}>
          <Txt v="small" color={C.accentText} style={styles.link}>{episode ? 'Ce n’est pas ça ?' : 'Corriger'}</Txt>
        </Press>
      </View>
      {pending && (
        <View style={styles.provRow}>
          <Ionicons name="people" size={14} color={C.accentText} />
          <Txt v="small" style={{ flex: 1, fontSize: 12 }} color={C.body}>
            Proposé par la communauté : {pending.from !== undefined ? `ch. ${pending.from}–${pending.to}` : `fin au ch. ${pending.to}`} ({plural(pending.confirmations, 'confirmation')})
          </Txt>
          {confirmed ? (
            <Txt v="small" color={C.success} style={styles.link}>Confirmé</Txt>
          ) : busy ? (
            <ActivityIndicator size="small" color={C.accentText} />
          ) : (
            <Press onPress={confirm} hitSlop={10} style={styles.confirm} accessibilityRole="button" accessibilityLabel="Confirmer cette proposition">
              <Ionicons name="thumbs-up" size={12} color={C.white} />
              <Txt v="small" color={C.white} style={styles.link}>Confirmer</Txt>
            </Press>
          )}
        </View>
      )}
      {error && <Txt v="small" color="#FF8A8A" style={{ fontSize: 12 }}>{error}</Txt>}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: S.lg, gap: 12, borderRadius: R.card + 4, borderCurve: 'continuous', borderWidth: 1,
    borderTopColor: C.accentLine, borderBottomColor: C.border, boxShadow: SHADOW.raised,
  },
  seg: { height: 6, borderRadius: 3 },
  provenance: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  provRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  link: { fontSize: 12, fontWeight: '700' },
  confirm: {
    flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 10, paddingVertical: 5,
    borderRadius: R.pill, backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
  segLabel: { fontSize: 11, fontWeight: '600' },
  play: {
    position: 'absolute', left: 19, top: 19, width: 26, height: 26, borderRadius: 13,
    backgroundColor: 'rgba(10,10,15,0.6)', alignItems: 'center', justifyContent: 'center',
  },
});
