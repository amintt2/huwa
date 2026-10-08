// "Réglages de lecture": one sheet, one level deep (a side panel in landscape, the video stays
// visible). The first page lists the five things a viewer changes, each with its current value:
//
//   Audio              → the file's audio tracks (sticky for the series)
//   Sous-titres        → tracks (translation included), local file, sync, appearance
//   Qualité et source  → what plays, max quality, automatic switching, the source list
//   Vitesse            → 0,5× … 2×
//   Plus               → auto-next, comments on the video, comments panel side, zoom, dub fallback
//
// A row opens its page in the same sheet, with a back chevron: never a sheet over a sheet.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Segmented } from '@/components/states';
import { Sheet, SheetLabel, SheetOption } from '@/components/sheet';
import { haptic, Txt, type IconName } from '@/components/ui';
import { setSetting, useSettings, type Settings } from '@/settings/settings';
import { C, DUR, R, S } from '@/theme/tokens';

import { SPEEDS } from './prefs';
import { SubtitlePanel, type SubtitleController } from './subtitles';

export type Option = { key: string; label: string; hint?: string };
export type SettingsPage = 'root' | 'audio' | 'subs' | 'source' | 'speed' | 'more';

const TITLES: Record<SettingsPage, string> = {
  root: 'Réglages de lecture',
  audio: 'Audio',
  subs: 'Sous-titres',
  source: 'Qualité et source',
  speed: 'Vitesse',
  more: 'Plus de réglages',
};

const QUALITIES: { value: Settings['quality']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: '1080p', label: '1080p' },
  { value: '720p', label: '720p' },
  { value: '480p', label: '480p' },
];

export const speedLabel = (r: number) => (r === 1 ? 'Normale' : `${String(r).replace('.', ',')}×`);
const switchProps = { trackColor: { true: C.accent, false: C.elevated }, thumbColor: C.white } as const;

/** One line of the first page: icon, title, current value, chevron. */
function NavRow({ icon, title, value, onPress, last }: { icon: IconName; title: string; value?: string; onPress: () => void; last?: boolean }) {
  return (
    <Pressable
      onPress={() => {
        haptic('select');
        onPress();
      }}
      accessibilityRole="button"
      accessibilityLabel={value ? `${title}, ${value}` : title}
      accessibilityHint="Ouvre les options"
      style={({ pressed }) => [styles.navRow, pressed && { backgroundColor: 'rgba(255,255,255,0.06)' }]}>
      <View style={styles.navIcon}>
        <Ionicons name={icon} size={18} color={C.text} />
      </View>
      <View style={[styles.navBody, !last && styles.navSep]}>
        <Txt v="label" style={{ flexShrink: 0 }}>{title}</Txt>
        <Txt v="small" numberOfLines={1} style={styles.navValue}>{value ?? ''}</Txt>
        <Ionicons name="chevron-forward" size={16} color={C.text3} />
      </View>
    </Pressable>
  );
}

function SwitchRow({ title, hint, value, onChange }: { title: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" style={{ fontSize: 15 }}>{title}</Txt>
        {hint ? <Txt v="small" style={{ fontSize: 12 }}>{hint}</Txt> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={title} {...switchProps} />
    </View>
  );
}

export function PlayerSettings({
  page,
  onPage,
  onClose,
  onClosed,
  rate,
  onRate,
  audio,
  audioKey,
  onAudio,
  subs,
  subsValue,
  sourceValue,
  sourceInfo,
  renderSources,
  autoNext,
  onAutoNext,
  commentsSide,
  onCommentsSide,
  liveComments,
  onLiveComments,
  fill,
  onFill,
}: {
  /** Page shown; null = closed. */
  page: SettingsPage | null;
  onPage: (p: SettingsPage) => void;
  onClose: () => void;
  /** The sheet finished closing (see Sheet). */
  onClosed?: () => void;
  rate: number;
  onRate: (r: number) => void;
  audio: Option[];
  audioKey: string;
  onAudio: (k: string) => void;
  subs: SubtitleController;
  /** Current subtitle track in words ("Français", "Désactivés"). */
  subsValue: string;
  /** Short value of the "Qualité et source" row ("720p · Auto"). */
  sourceValue?: string;
  /** What plays and the last automatic source change. */
  sourceInfo?: { label: string; detail?: string };
  /** The source list (watch screen); `done` closes the sheet once a source is chosen. */
  renderSources?: (done: () => void) => ReactNode;
  autoNext: boolean;
  onAutoNext: (v: boolean) => void;
  commentsSide: 'left' | 'right';
  onCommentsSide: (side: 'left' | 'right') => void;
  liveComments: boolean;
  onLiveComments: (v: boolean) => void;
  /** Fullscreen zoom (fill the screen); undefined when not in fullscreen. */
  fill?: boolean;
  onFill?: (v: boolean) => void;
}) {
  const s = useSettings();
  const visible = page != null;
  // The page stays drawn while the sheet slides away.
  const shown = page ?? 'root';
  const audioLabel = audio.find((o) => o.key === audioKey)?.label;

  const back = (
    <Pressable onPress={() => onPage('root')} hitSlop={10} accessibilityRole="button" accessibilityLabel="Retour aux réglages"
      style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
      <Ionicons name="chevron-back" size={20} color={C.text} />
    </Pressable>
  );

  let content: ReactNode;
  if (shown === 'root') {
    const rows: { key: SettingsPage; icon: IconName; title: string; value?: string }[] = [
      ...(audio.length > 1 ? [{ key: 'audio' as const, icon: 'volume-high-outline' as const, title: 'Audio', value: audioLabel }] : []),
      { key: 'subs', icon: 'chatbox-ellipses-outline', title: 'Sous-titres', value: subsValue },
      ...(sourceInfo || renderSources ? [{ key: 'source' as const, icon: 'layers-outline' as const, title: 'Qualité et source', value: sourceValue }] : []),
      { key: 'speed', icon: 'speedometer-outline', title: 'Vitesse', value: speedLabel(rate) },
      { key: 'more', icon: 'ellipsis-horizontal-circle-outline', title: 'Plus' },
    ];
    content = (
      <View style={styles.group}>
        {rows.map((r, i) => (
          <NavRow key={r.key} icon={r.icon} title={r.title} value={r.value} onPress={() => onPage(r.key)} last={i === rows.length - 1} />
        ))}
      </View>
    );
  } else if (shown === 'audio') {
    content = (
      <View style={{ gap: S.sm }}>
        {audio.map((o) => (
          <SheetOption key={o.key} title={o.label} detail={o.hint} on={o.key === audioKey} onPress={() => { haptic('select'); onAudio(o.key); }} />
        ))}
        <Txt v="small" style={{ fontSize: 12 }}>Ton choix est gardé pour les prochains épisodes de cette série.</Txt>
      </View>
    );
  } else if (shown === 'subs') {
    content = <SubtitlePanel ctl={subs} />;
  } else if (shown === 'source') {
    content = (
      <>
        {sourceInfo && (
          <View style={styles.info} accessibilityRole="text">
            <Txt v="label" numberOfLines={2}>{sourceInfo.label}</Txt>
            {sourceInfo.detail ? <Txt v="small" style={{ fontSize: 12 }}>{sourceInfo.detail}</Txt> : null}
          </View>
        )}
        <View style={{ gap: S.sm }}>
          <SheetLabel>Qualité maximale</SheetLabel>
          <Segmented accessibilityLabel="Qualité maximale" value={s.quality} onChange={(q) => setSetting('quality', q)} options={QUALITIES} />
        </View>
        <SwitchRow title="Changer de source automatiquement" hint="Meilleure qualité quand le réseau suit, source plus stable si ça coupe. Jamais une autre langue."
          value={s.autoSwitchSource} onChange={(v) => setSetting('autoSwitchSource', v)} />
        {renderSources && (
          <View style={{ gap: S.sm }}>
            <SheetLabel>Sources</SheetLabel>
            {renderSources(onClose)}
          </View>
        )}
      </>
    );
  } else if (shown === 'speed') {
    content = (
      <View style={{ gap: S.sm }}>
        {SPEEDS.map((r) => (
          <SheetOption key={r} title={speedLabel(r)} on={r === rate} onPress={() => { haptic('select'); onRate(r); }} />
        ))}
      </View>
    );
  } else {
    content = (
      <>
        <SwitchRow title="Épisode suivant automatique" hint="Lance la suite après un compte à rebours." value={autoNext} onChange={onAutoNext} />
        <SwitchRow title="Commentaires sur la vidéo" hint="En plein écran, les commentaires horodatés apparaissent au bon moment." value={liveComments} onChange={onLiveComments} />
        <View style={{ gap: S.sm }}>
          <SheetLabel>Panneau des commentaires (paysage)</SheetLabel>
          <Segmented accessibilityLabel="Côté du panneau des commentaires" value={commentsSide} onChange={onCommentsSide}
            options={[{ value: 'left', label: 'À gauche' }, { value: 'right', label: 'À droite' }]} />
        </View>
        {fill !== undefined && onFill && (
          <SwitchRow title="Remplir l’écran" hint="Zoome pour supprimer les bandes noires (les bords sont coupés). Aussi en pinçant l’image." value={fill} onChange={onFill} />
        )}
        {s.watchMode === 'dub' && (
          <SwitchRow title="Passer en VO quand la VF manque" hint="Sans demander : la meilleure autre version démarre." value={s.dubAutoFallback} onChange={(v) => setSetting('dubAutoFallback', v)} />
        )}
      </>
    );
  }

  return (
    <Sheet visible={visible} onClose={onClose} onClosed={onClosed} title={TITLES[shown]} headerLeft={shown !== 'root' ? back : undefined} detents="fit" side>
      {/* Keyed by page: each page fades in instead of morphing from the previous one. */}
      <Animated.View key={shown} entering={FadeIn.duration(DUR.release)} style={{ gap: S.lg }}>
        {content}
      </Animated.View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  group: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, overflow: 'hidden' },
  navRow: { flexDirection: 'row', alignItems: 'center', paddingLeft: 14, minHeight: 52 },
  navIcon: { width: 30, height: 30, borderRadius: 8, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.08)' },
  navBody: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm, alignSelf: 'stretch', marginLeft: S.md, paddingRight: 14 },
  navSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  navValue: { flex: 1, textAlign: 'right', fontSize: 14, color: C.text2 },
  back: { width: 30, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.10)', marginRight: -4 },
  info: { gap: 4, padding: 14, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.md },
});
