// Not-yet-aired episodes of a season still airing (anime page): distinct, non-playable rows
// after the aired ones, with the airing date in local time, a live countdown under 24 h and a
// bell to be reminded of that one episode. See data/upcoming.ts (schedule) and
// notifications/plan.ts (what gets scheduled).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { airingDate, airingTime, nextEpisodeLine, relativeAiring, relativeTick, COUNTDOWN_MS, upcomingLabel, type AiringNode } from '@/data/airing';
import { allowReminders } from '@/notifications/episodes';
import type { EpisodeReminder } from '@/notifications/plan';
import { setEpisodeReminder, setSeriesReminder } from '@/store/store';
import { C, F, S } from '@/theme/tokens';

import { Press, Txt } from './ui';

/** Turn the « Me rappeler » bell of a series on (asks for notifications first) or off. */
export async function toggleSeriesBell(seriesId: string, on: boolean) {
  if (on && !(await allowReminders())) return;
  setSeriesReminder(seriesId, on);
}

/** Turn the bell of one upcoming episode on (asks for notifications first) or off. */
export async function toggleEpisodeBell(r: EpisodeReminder, on: boolean) {
  if (on && !(await allowReminders())) return;
  setEpisodeReminder(r, on);
}

/** "dans 3 j", then a countdown that ticks every second under 24 h. */
function RelativeAiring({ airingAt }: { airingAt: number }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setTimeout(() => setNow(Date.now()), relativeTick(airingAt, now));
    return () => clearTimeout(timer);
  }, [airingAt, now]);
  const soon = airingAt * 1000 - now < COUNTDOWN_MS;
  return (
    <Txt v="footnote" tabular numberOfLines={1} color={soon ? C.accentText : C.text3}>
      {relativeAiring(airingAt, now)}
    </Txt>
  );
}

/** "Prochain épisode : Ép. 8 · jeu. 17:30", under the play button. */
export function NextEpisodeLine({ node, now }: { node: AiringNode; now: number }) {
  return (
    <View style={styles.next} accessible accessibilityLabel={`Prochain épisode : épisode ${node.episode}, ${airingDate(node.airingAt)} à ${airingTime(node.airingAt)}`}>
      <Ionicons name="time-outline" size={13} color={C.text2} />
      <Txt v="footnote" tabular numberOfLines={1} style={{ flexShrink: 1 }}>{nextEpisodeLine(node, now)}</Txt>
    </View>
  );
}

/** "À venir" header of the upcoming rows. */
export function UpcomingHeader() {
  return <Txt v="caption" accessibilityRole="header" style={{ marginTop: S.xs }}>À venir</Txt>;
}

/**
 * One episode still to air. `covered`: notified anyway (series bell, or "Ma liste" with the
 * global setting), the bell shows it and stays off-limits.
 */
export function UpcomingRow({
  seriesId,
  node,
  reminded,
  covered,
}: {
  seriesId: string;
  node: AiringNode;
  reminded: boolean;
  covered: boolean;
}) {
  const on = reminded || covered;
  const when = `${airingDate(node.airingAt)} à ${airingTime(node.airingAt)}`;
  return (
    <View style={styles.row} accessible={false}>
      <View style={styles.thumb} accessible accessibilityLabel={`Épisode ${node.episode}, pas encore sorti, ${when}`}>
        <Ionicons name="calendar-outline" size={18} color={C.text2} />
        <Txt v="footnote" tabular color={C.text2} style={F.semibold}>{`Ép. ${node.episode}`}</Txt>
      </View>
      <View style={{ flex: 1, gap: 4 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Txt v="label" numberOfLines={2} color={C.text2} tabular>{upcomingLabel(node)}</Txt>
        <RelativeAiring airingAt={node.airingAt} />
      </View>
      <Press
        onPress={covered ? undefined : () => void toggleEpisodeBell({ seriesId, episode: node.episode, airingAt: node.airingAt }, !reminded)}
        disabled={covered}
        haptics="select"
        scaleTo={0.9}
        hitSlop={8}
        style={styles.bell}
        accessibilityRole="button"
        accessibilityState={{ selected: on, disabled: covered }}
        accessibilityLabel={
          covered ? `Rappel déjà activé pour toute la série` : reminded ? `Ne plus me rappeler l’épisode ${node.episode}` : `Me rappeler l’épisode ${node.episode}`
        }>
        <Ionicons name={on ? 'notifications' : 'notifications-outline'} size={22} color={covered ? C.text3 : on ? C.accentText : C.text2} />
      </Press>
    </View>
  );
}

const styles = StyleSheet.create({
  next: { flexDirection: 'row', alignItems: 'center', gap: 5, paddingHorizontal: 2 },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 77 },
  thumb: {
    width: 136, height: 77, borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', gap: 4,
    backgroundColor: C.surface, borderWidth: 1, borderStyle: 'dashed', borderColor: C.borderStrong,
  },
  bell: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center' },
});
