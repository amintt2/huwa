// "Sous-titres" page of the player settings sheet (PlayerSettings): track list grouped by language
// (on-device translation included), local file, sync offset, quick style. The sheet is a side
// panel in landscape, so the subtitles stay visible while adjusting.
import Ionicons from '@expo/vector-icons/Ionicons';
import { ActivityIndicator, Pressable, StyleSheet, Text, View } from 'react-native';

import { FLAG } from '@/components/language-prefs';
import { SheetLabel } from '@/components/sheet';
import { haptic, Txt } from '@/components/ui';
import { langName } from '@/subtitles/lang';
import { useSubtitlePrefs } from '@/subtitles/prefs';
import { trackHint, type Track } from '@/subtitles/select';
import { C, F, R, S } from '@/theme/tokens';

import { StyleControls } from './StyleControls';
import type { SubtitleController } from './useSubtitles';

const fmtOffset = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1).replace('.', ',')} s`;

function TrackRow({ track, on, busy, onPress, hint }: { track: Track | null; on: boolean; busy?: boolean; onPress: () => void; hint?: string }) {
  const title = track ? track.name && track.kind !== 'local' ? track.name : track.kind === 'local' ? track.source : langName(track.lang) : 'Désactivés';
  return (
    <Pressable
      onPress={() => {
        haptic('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      accessibilityLabel={`${title}${hint ? `, ${hint}` : ''}`}
      style={({ pressed }) => [styles.track, on && styles.trackOn, pressed && { opacity: 0.7 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1} style={{ fontSize: 14 }} color={on ? C.accentText : C.text}>{title}</Txt>
        {hint ? <Txt v="small" numberOfLines={1} style={{ fontSize: 12 }}>{hint}</Txt> : null}
      </View>
      {busy ? <ActivityIndicator color={C.accentText} /> : on ? <Ionicons name="checkmark" size={20} color={C.accentText} /> : null}
    </Pressable>
  );
}

function Step({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityLabel={`Décaler de ${label}`} hitSlop={4}
      style={({ pressed }) => [styles.step, pressed && { opacity: 0.6 }]}>
      <Text style={styles.stepText}>{label}</Text>
    </Pressable>
  );
}

export function SubtitlePanel({ ctl }: { ctl: SubtitleController }) {
  const prefs = useSubtitlePrefs();
  const drawn = !!ctl.selected && ctl.selected.kind !== 'embedded';

  return (
    <>
      <View style={{ gap: S.sm }}>
        <SheetLabel>Piste</SheetLabel>
        <TrackRow track={null} on={ctl.selectedKey === 'off'} onPress={() => ctl.select('off')} />
        {ctl.groups.map((g) => (
          <View key={g.lang} style={{ gap: 6 }}>
            <Txt v="small" style={styles.groupTitle}>{FLAG[g.lang.split('-')[0]] ? `${FLAG[g.lang.split('-')[0]]}  ` : ''}{g.title}</Txt>
            {g.tracks.map((t) => {
              const on = t.key === ctl.selectedKey;
              return <TrackRow key={t.key} track={t} on={on} busy={on && ctl.loading} onPress={() => ctl.select(t.key)} hint={trackHint(t, on ? ctl.loadedFormat : undefined)} />;
            })}
          </View>
        ))}
        {ctl.locals.length > 0 && (
          <View style={{ gap: 6 }}>
            <Txt v="small" style={styles.groupTitle}>Fichiers locaux</Txt>
            {ctl.locals.map((t) => (
              <TrackRow key={t.key} track={t} on={t.key === ctl.selectedKey} onPress={() => ctl.select(t.key)} hint={trackHint(t)} />
            ))}
          </View>
        )}
        {ctl.groups.length === 0 && ctl.locals.length === 0 && <Txt v="small">Aucun sous-titre trouvé pour cette source.</Txt>}
        {!!ctl.error && (
          <View style={styles.error} accessibilityLiveRegion="polite">
            <Ionicons name="alert-circle" size={16} color="#FF8A8A" />
            <Txt v="small" style={{ flex: 1, color: '#FFB4B4' }}>{ctl.error}</Txt>
          </View>
        )}
        <Pressable onPress={ctl.addLocalFile} disabled={ctl.picking} accessibilityRole="button" accessibilityLabel="Charger un fichier de sous-titres"
          style={({ pressed }) => [styles.fileBtn, pressed && { opacity: 0.7 }]}>
          {ctl.picking ? <ActivityIndicator color={C.accentText} /> : <Ionicons name="folder-open-outline" size={18} color={C.accentText} />}
          <Text style={styles.fileText}>Charger un fichier (.ass, .srt, .vtt)</Text>
        </Pressable>
        {ctl.selected?.kind === 'embedded' && (
          <Txt v="small" style={{ fontSize: 12 }}>Piste intégrée : affichée par le lecteur système, sans style ni décalage.</Txt>
        )}
      </View>

      {drawn && ctl.canOffset && (
        <View style={{ gap: S.sm }}>
          <SheetLabel>Synchronisation</SheetLabel>
          <View style={styles.syncRow}>
            <Step label="−0,5" onPress={() => ctl.setOffset(ctl.offset - 0.5)} />
            <Step label="−0,1" onPress={() => ctl.setOffset(ctl.offset - 0.1)} />
            <Pressable onPress={() => ctl.setOffset(0)} accessibilityRole="button" accessibilityLabel="Remettre le décalage à zéro" style={styles.syncValue}>
              <Text style={[styles.syncText, ctl.offset !== 0 && { color: C.accentText }]}>{fmtOffset(ctl.offset)}</Text>
            </Pressable>
            <Step label="+0,1" onPress={() => ctl.setOffset(ctl.offset + 0.1)} />
            <Step label="+0,5" onPress={() => ctl.setOffset(ctl.offset + 0.5)} />
          </View>
          <Txt v="small" style={{ fontSize: 12 }}>
            {ctl.offset === 0 ? '+ : les sous-titres arrivent plus tard. Mémorisé pour cet épisode.' : 'Mémorisé pour cet épisode. Touche la valeur pour revenir à 0.'}
          </Txt>
        </View>
      )}

      {drawn && (
        <View style={{ gap: S.sm }}>
          <SheetLabel>Apparence</SheetLabel>
          <StyleControls prefs={prefs} compact />
        </View>
      )}
    </>
  );
}

const styles = StyleSheet.create({
  groupTitle: { fontSize: 12, ...F.bold, color: C.body, paddingHorizontal: 2, marginTop: 2 },
  track: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 48, paddingHorizontal: 14, paddingVertical: 8,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  trackOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  syncRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  step: {
    flex: 1, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  stepText: { color: C.text, fontSize: 14, ...F.semibold, fontVariant: ['tabular-nums'] },
  syncValue: { minWidth: 78, height: 40, alignItems: 'center', justifyContent: 'center' },
  syncText: { color: C.text, fontSize: 16, ...F.bold, fontVariant: ['tabular-nums'] },
  error: { flexDirection: 'row', alignItems: 'center', gap: 8, padding: 10, borderRadius: R.control, backgroundColor: 'rgba(255,107,107,0.12)' },
  fileBtn: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, minHeight: 44, borderRadius: R.control,
    borderCurve: 'continuous', borderWidth: 1, borderStyle: 'dashed', borderColor: C.accentLine,
  },
  fileText: { color: C.accentText, fontSize: 14, ...F.semibold },
});
