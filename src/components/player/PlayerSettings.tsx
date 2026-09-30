import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, ScrollView, StyleSheet, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Txt } from '@/components/ui';
import { C, R, S } from '@/theme/tokens';

import { SPEEDS, SUBTITLE_SIZES, type SubtitleSize } from './prefs';

export type Option = { key: string; label: string; hint?: string };

function Row({ title, options, value, onPick }: { title: string; options: Option[]; value: string; onPick: (k: string) => void }) {
  return (
    <View style={{ gap: S.sm }}>
      <Txt v="caption">{title}</Txt>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
        {options.map((o) => {
          const on = o.key === value;
          return (
            <Pressable
              key={o.key}
              onPress={() => onPick(o.key)}
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              style={[styles.opt, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
              <Txt v="label" style={{ fontSize: 14 }} color={on ? C.accentText : C.text}>{o.label}</Txt>
              {o.hint ? <Txt v="small" style={{ fontSize: 11 }}>{o.hint}</Txt> : null}
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
  autoNext,
  onAutoNext,
}: {
  visible: boolean;
  onClose: () => void;
  rate: number;
  onRate: (r: number) => void;
  audio: Option[];
  audioKey: string;
  onAudio: (k: string) => void;
  subtitles: Option[];
  subtitleKey: string;
  onSubtitle: (k: string) => void;
  subtitleNote?: string;
  size: SubtitleSize;
  onSize: (s: SubtitleSize) => void;
  autoNext: boolean;
  onAutoNext: (v: boolean) => void;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
      <Pressable style={styles.backdrop} onPress={onClose} accessibilityLabel="Fermer les réglages" />
      <View style={[styles.sheet, { paddingBottom: insets.bottom + S.lg, paddingLeft: insets.left + S.lg, paddingRight: insets.right + S.lg }]}>
        <View style={styles.head}>
          <Txt v="section" style={{ fontSize: 16 }}>Réglages de lecture</Txt>
          <Pressable onPress={onClose} hitSlop={12} accessibilityRole="button" accessibilityLabel="Fermer">
            <Ionicons name="close" size={22} color={C.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ gap: S.lg, paddingBottom: S.sm }}>
          <Row title="Vitesse" value={String(rate)} onPick={(k) => onRate(Number(k))}
            options={SPEEDS.map((s) => ({ key: String(s), label: s === 1 ? 'Normale' : `${String(s).replace('.', ',')}×` }))} />
          <Row title="Sous-titres" value={subtitleKey} onPick={onSubtitle} options={subtitles} />
          {subtitleNote ? <Txt v="small">{subtitleNote}</Txt> : null}
          <Row title="Taille des sous-titres" value={size} onPick={(k) => onSize(k as SubtitleSize)}
            options={(Object.keys(SUBTITLE_SIZES) as SubtitleSize[]).map((k) => ({ key: k, label: { S: 'Petite', M: 'Moyenne', L: 'Grande', XL: 'Très grande' }[k] }))} />
          {audio.length > 1 && <Row title="Audio" value={audioKey} onPick={onAudio} options={audio} />}
          <View style={styles.switchRow}>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" style={{ fontSize: 14 }}>Épisode suivant automatique</Txt>
              <Txt v="small" style={{ fontSize: 12 }}>Lance la suite après un compte à rebours.</Txt>
            </View>
            <Switch value={autoNext} onValueChange={onAutoNext} trackColor={{ true: C.accent, false: C.elevated }} />
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '82%', paddingTop: S.lg, gap: S.md,
    backgroundColor: C.surface, borderTopLeftRadius: R.sheet, borderTopRightRadius: R.sheet, borderCurve: 'continuous',
    borderWidth: 1, borderColor: C.border,
  },
  head: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  opt: {
    minHeight: 40, paddingHorizontal: 14, paddingVertical: 8, justifyContent: 'center', borderRadius: R.control,
    borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingTop: S.xs },
});
