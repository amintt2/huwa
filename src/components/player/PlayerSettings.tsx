import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';

import { Sheet, SheetLabel } from '@/components/sheet';
import { haptic, Txt } from '@/components/ui';
import { C, R, S } from '@/theme/tokens';

import { SPEEDS, SUBTITLE_SIZES, type SubtitleSize } from './prefs';

const SIZE_LABELS: Record<SubtitleSize, string> = { S: 'Petite', M: 'Moyenne', L: 'Grande', XL: 'Très grande' };

export type Option = { key: string; label: string; hint?: string };

function Row({ title, options, value, onPick }: { title: string; options: Option[]; value: string; onPick: (k: string) => void }) {
  return (
    <View style={{ gap: S.sm }}>
      <SheetLabel>{title}</SheetLabel>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              onPress={() => {
                haptic('select');
                onPick(o.key);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.opt, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
              <Txt v="label" tabular style={{ fontSize: 14 }} color={on ? C.accentText : C.text}>{o.label}</Txt>
              {o.hint ? <Txt v="footnote" style={{ fontSize: 11 }}>{o.hint}</Txt> : null}
            </Pressable>
          );
        })}
      </ScrollView>
    </View>
  );
}

export function PlayerSettings({
  visible,
  onClose,
  rate,
  onRate,
  audio,
  audioKey,
  onAudio,
  subtitles,
  subtitleKey,
  onSubtitle,
  subtitleNote,
  size,
  onSize,
  onOpenSubtitles,
  autoNext,
  onAutoNext,
  commentsSide,
  onCommentsSide,
  liveComments,
  onLiveComments,
  onClosed,
}: {
  visible: boolean;
  onClose: () => void;
  rate: number;
  onRate: (r: number) => void;
  audio: Option[];
  audioKey: string;
  onAudio: (k: string) => void;
  /** Simple subtitle list (players without the full subtitle sheet). */
  subtitles?: Option[];
  subtitleKey?: string;
  onSubtitle?: (k: string) => void;
  subtitleNote?: string;
  size?: SubtitleSize;
  onSize?: (s: SubtitleSize) => void;
  /** Opens the subtitle sheet (tracks, sync, style) instead of the simple list. */
  onOpenSubtitles?: () => void;
  autoNext: boolean;
  onAutoNext: (v: boolean) => void;
  commentsSide: 'left' | 'right';
  onCommentsSide: (side: 'left' | 'right') => void;
  liveComments: boolean;
  onLiveComments: (v: boolean) => void;
  /** The sheet finished closing (see Sheet). */
  onClosed?: () => void;
}) {
  return (
    <Sheet visible={visible} onClose={onClose} onClosed={onClosed} title="Réglages de lecture" detents="fit">
      <Row title="Vitesse" value={String(rate)} onPick={(k) => onRate(Number(k))}
        options={SPEEDS.map((s) => ({ key: String(s), label: s === 1 ? 'Normale' : `${String(s).replace('.', ',')}×` }))} />
      {onOpenSubtitles && (
        <Pressable onPress={onOpenSubtitles} accessibilityRole="button" style={({ pressed }) => [styles.linkRow, pressed && { opacity: 0.6 }]}>
          <Ionicons name="text" size={18} color={C.accentText} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label" style={{ fontSize: 14 }}>Sous-titres</Txt>
            <Txt v="small" style={{ fontSize: 12 }}>Piste, synchronisation, police et style</Txt>
          </View>
          <Ionicons name="chevron-forward" size={16} color={C.text2} />
        </Pressable>
      )}
      {subtitles && subtitleKey !== undefined && onSubtitle && <Row title="Sous-titres" value={subtitleKey} onPick={onSubtitle} options={subtitles} />}
      {subtitleNote ? <Txt v="small">{subtitleNote}</Txt> : null}
      {size && onSize && (
        <Row title="Taille des sous-titres" value={size} onPick={(k) => onSize(k as SubtitleSize)}
          options={(Object.keys(SUBTITLE_SIZES) as SubtitleSize[]).map((k) => ({ key: k, label: SIZE_LABELS[k] }))} />
      )}
      {audio.length > 1 && <Row title="Audio" value={audioKey} onPick={onAudio} options={audio} />}
      <View style={styles.switchRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 14 }}>Épisode suivant automatique</Txt>
          <Txt v="small" style={{ fontSize: 12 }}>Lance la suite après un compte à rebours.</Txt>
        </View>
        <Switch value={autoNext} onValueChange={onAutoNext} trackColor={{ true: C.accent, false: C.elevated }} />
      </View>
      <View style={styles.switchRow}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label" style={{ fontSize: 14 }}>Commentaires sur la vidéo</Txt>
          <Txt v="small" style={{ fontSize: 12 }}>En plein écran, les commentaires horodatés apparaissent au bon moment.</Txt>
        </View>
        <Switch value={liveComments} onValueChange={onLiveComments} trackColor={{ true: C.accent, false: C.elevated }} />
      </View>
      <Row title="Panneau des commentaires (paysage)" value={commentsSide} onPick={(k) => onCommentsSide(k as 'left' | 'right')}
        options={[{ key: 'left', label: 'À gauche' }, { key: 'right', label: 'À droite' }]} />
    </Sheet>
  );
}

const styles = StyleSheet.create({
  opt: {
    minHeight: 40, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center', borderRadius: R.control,
    borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingTop: S.xs },
  linkRow: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 52, paddingHorizontal: 14, borderRadius: R.control,
    borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
});
