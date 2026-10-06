// Reader settings sheet: Global / Source / Titre scopes (Paperback-style), each Source / Titre
// scope either synced with its parent or overriding it. Changes apply live behind the sheet.
import { useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Switch, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';

import { Sheet } from '@/components/sheet';
import { haptic, Txt } from '@/components/ui';
import { C, F, R, S } from '@/theme/tokens';

import { clampWidth, isSynced, settingsAt, type ReaderSettings, type Scope, type ScopeKeys } from './settings';
import { setReaderSetting, setScopeSync, useSettingsState } from './settings-store';

// ---------- controls ----------

function Segmented<T extends string>({ options, value, onPick, label }: { options: { key: T; label: string }[]; value: T; onPick: (v: T) => void; label: string }) {
  return (
    <View style={styles.seg} accessibilityRole="radiogroup" accessibilityLabel={label}>
      {options.map((o) => {
        const on = o.key === value;
        return (
          <Pressable key={o.key} onPress={() => {
            if (!on) haptic('select');
            onPick(o.key);
          }} accessibilityRole="radio" accessibilityState={{ checked: on }} accessibilityLabel={o.label}
            style={[styles.segItem, on && styles.segOn]}>
            <Txt v="small" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.8} color={on ? C.text : C.text2} style={on ? F.semibold : undefined}>{o.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** 30–100 % slider, 5 % steps. */
function PercentSlider({ value, onChange, label }: { value: number; onChange: (v: number) => void; label: string }) {
  const [w, setW] = useState(0);
  const last = useSharedValue(value);
  const live = useSharedValue(-1);
  const frac = (value - 0.3) / 0.7;
  const set = (v: number) => {
    haptic('select');
    onChange(v);
  };
  const at = (x: number) => {
    'worklet';
    const f = Math.min(1, Math.max(0, (x - 13) / Math.max(1, w)));
    live.set(f);
    const v = Math.round((0.3 + f * 0.7) * 20) / 20;
    if (v !== last.get()) {
      last.set(v);
      scheduleOnRN(set, v);
    }
  };
  const pan = Gesture.Pan()
    .activeOffsetX([-4, 4])
    .failOffsetY([-14, 14])
    .onBegin((e) => {
      'worklet';
      last.set(-1);
      at(e.x);
    })
    .onUpdate((e) => {
      'worklet';
      at(e.x);
    })
    .onFinalize(() => {
      'worklet';
      live.set(-1);
    });
  const tap = Gesture.Tap().onEnd((e) => {
    'worklet';
    last.set(-1);
    at(e.x);
    live.set(-1);
  });
  const fill = useAnimatedStyle(() => ({ width: (live.get() >= 0 ? live.get() : frac) * w }));
  const knob = useAnimatedStyle(() => ({ transform: [{ translateX: (live.get() >= 0 ? live.get() : frac) * w }] }));
  return (
    <GestureDetector gesture={Gesture.Exclusive(pan, tap)}>
      <View
        onLayout={(e) => setW(e.nativeEvent.layout.width - 26)}
        style={styles.slider}
        accessible
        accessibilityRole="adjustable"
        accessibilityLabel={label}
        accessibilityValue={{ text: `${Math.round(value * 100)} %` }}
        accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
        onAccessibilityAction={(e) => onChange(clampWidth(value + (e.nativeEvent.actionName === 'increment' ? 0.05 : -0.05)))}>
        <View style={styles.sliderTrack}>
          <Animated.View style={[styles.sliderFill, fill]} />
        </View>
        <Animated.View style={[styles.knob, knob]} />
      </View>
    </GestureDetector>
  );
}

function Card({ title, children, note }: { title?: string; children: ReactNode; note?: string }) {
  return (
    <View style={{ gap: S.sm }}>
      {title ? <Txt v="caption" style={{ paddingHorizontal: S.xs }}>{title}</Txt> : null}
      <View style={styles.card}>{children}</View>
      {note ? <Txt v="footnote" style={{ paddingHorizontal: S.xs }}>{note}</Txt> : null}
    </View>
  );
}

function Line({ label, detail, children, right, last }: { label: string; detail?: string; children?: ReactNode; right?: ReactNode; last?: boolean }) {
  return (
    <View style={[styles.line, !last && styles.lineSep]}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <View style={{ flex: 1, gap: 2 }}>
          <Txt v="label">{label}</Txt>
          {detail ? <Txt v="footnote">{detail}</Txt> : null}
        </View>
        {right}
      </View>
      {children}
    </View>
  );
}

function Toggle({ label, detail, value, onChange, last }: { label: string; detail?: string; value: boolean; onChange: (v: boolean) => void; last?: boolean }) {
  return (
    <Line label={label} detail={detail} last={last}
      right={<Switch value={value} onValueChange={onChange} accessibilityLabel={label} trackColor={{ true: C.accent, false: C.surface }} thumbColor={C.white} />} />
  );
}

// ---------- sheet ----------

export function ReaderSettingsSheet({
  visible,
  onClose,
  keys,
  sourceName,
  seriesTitle,
}: {
  visible: boolean;
  onClose: () => void;
  keys: ScopeKeys;
  sourceName: string;
  seriesTitle: string;
}) {
  const state = useSettingsState();
  const [scope, setScope] = useState<Scope>(() => (keys.title && !isSynced(state, 'title', keys) ? 'title' : keys.source && !isSynced(state, 'source', keys) ? 'source' : 'global'));
  const s = settingsAt(state, scope, keys);
  const synced = isSynced(state, scope, keys);
  const set = (patch: Partial<ReaderSettings>) => setReaderSetting(scope, keys, patch);

  const scopes: { key: Scope; label: string }[] = [
    { key: 'global', label: 'Global' },
    ...(keys.source ? [{ key: 'source' as const, label: 'Source' }] : []),
    ...(keys.title ? [{ key: 'title' as const, label: 'Titre' }] : []),
  ];

  return (
    <Sheet visible={visible} onClose={onClose} title="Réglages du lecteur" subtitle={scope === 'global' ? 'Tous les titres' : scope === 'source' ? `Source · ${sourceName}` : seriesTitle}
      detents={['medium', 'large']}>
      <Segmented label="Portée des réglages" options={scopes} value={scope} onPick={setScope} />

      {scope !== 'global' && (
        <Card>
          <Toggle last label="Synchroniser avec le parent"
            detail={scope === 'source' ? 'Utiliser les réglages globaux' : `Utiliser les réglages de ${keys.source ? 'la source' : 'Global'}`}
            value={synced} onChange={(v) => setScopeSync(scope, keys, v)} />
        </Card>
      )}

      <View style={{ gap: S.lg, opacity: synced ? 0.45 : 1 }} pointerEvents={synced ? 'none' : 'auto'} accessibilityElementsHidden={synced}>
        <Card>
          <Line label="Type de lecteur">
            <Segmented label="Type de lecteur" value={s.type} onPick={(type) => set({ type })}
              options={[{ key: 'vertical', label: 'Vertical continu' }, { key: 'paged', label: 'Pages' }]} />
          </Line>
          <Line last label="Sens de lecture" detail={s.type === 'vertical' ? 'Utilisé en mode pages' : undefined}>
            <Segmented label="Sens de lecture" value={s.direction} onPick={(direction) => set({ direction })}
              options={[{ key: 'rtl', label: 'Manga (←)' }, { key: 'ltr', label: 'Gauche → droite' }, { key: 'webtoon', label: 'Webtoon' }]} />
          </Line>
        </Card>

        <Card title="Largeur maximale des pages">
          <Line label="Portrait" right={<Txt v="small" tabular color={C.accentText}>{Math.round(s.widthPortrait * 100)} %</Txt>}>
            <PercentSlider label="Largeur en portrait" value={s.widthPortrait} onChange={(widthPortrait) => set({ widthPortrait })} />
          </Line>
          <Line last label="Paysage" right={<Txt v="small" tabular color={C.accentText}>{Math.round(s.widthLandscape * 100)} %</Txt>}>
            <PercentSlider label="Largeur en paysage" value={s.widthLandscape} onChange={(widthLandscape) => set({ widthLandscape })} />
          </Line>
        </Card>

        <Card title="Affichage">
          <Toggle label="Séparer les pages" detail="Un espace entre les pages" value={s.separate} onChange={(separate) => set({ separate })} />
          <Toggle label="Alléger les grandes pages" detail="Les images sont réduites à la taille de l’écran : moins de mémoire, défilement plus fluide"
            value={s.downsample} onChange={(downsample) => set({ downsample })} />
          <Line last label="Fond du lecteur">
            <Segmented label="Fond du lecteur" value={s.background} onPick={(background) => set({ background })}
              options={[{ key: 'theme', label: 'Thème' }, { key: 'black', label: 'Noir' }, { key: 'gray', label: 'Gris' }, { key: 'white', label: 'Blanc' }]} />
          </Line>
        </Card>

        <Card title="Commandes">
          <Line label="Disposition" detail="Côté des boutons et de la barre des pages">
            <Segmented label="Disposition" value={s.hand} onPick={(hand) => set({ hand })}
              options={[{ key: 'right', label: 'Droitier' }, { key: 'left', label: 'Gaucher' }]} />
          </Line>
          <Toggle label="Masquer la barre d’état" detail="Cache l’heure et l’indicateur d’accueil quand l’interface est masquée"
            value={s.hideBars} onChange={(hideBars) => set({ hideBars })} />
          <Toggle label="Toucher pour défiler" detail="Touche les bords de l’écran pour avancer ou reculer ; le centre affiche l’interface"
            value={s.tapToScroll} onChange={(tapToScroll) => set({ tapToScroll })} />
          <Toggle label="Masquer l’interface en lisant" detail="L’interface disparaît dès que tu fais défiler"
            value={s.autoHide} onChange={(autoHide) => set({ autoHide })} />
          <Toggle label="Toujours afficher le numéro de page" value={s.pageNumber} onChange={(pageNumber) => set({ pageNumber })} />
          <Toggle label="Verrouiller l’orientation" detail="Le lecteur reste dans l’orientation actuelle"
            value={s.orientationLock} onChange={(orientationLock) => set({ orientationLock })} />
          <Toggle last label="Garder l’écran allumé" value={s.keepAwake} onChange={(keepAwake) => set({ keepAwake })} />
        </Card>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  seg: {
    flexDirection: 'row', padding: 3, gap: 3, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: 'rgba(0,0,0,0.28)', borderWidth: 1, borderColor: C.hairline,
  },
  segItem: { flex: 1, minHeight: 38, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6, borderRadius: 9, borderCurve: 'continuous' },
  segOn: { backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong, boxShadow: '0px 1px 3px rgba(0,0,0,0.4)' },
  card: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)', overflow: 'hidden' },
  line: { paddingHorizontal: 14, paddingVertical: 12, gap: 10, minHeight: 52, justifyContent: 'center' },
  lineSep: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline },
  slider: { height: 32, justifyContent: 'center', paddingHorizontal: 13 },
  sliderTrack: { height: 6, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.12)', overflow: 'hidden' },
  sliderFill: { height: 6, backgroundColor: C.accent },
  knob: {
    position: 'absolute', left: 0, width: 26, height: 26, borderRadius: 13, backgroundColor: C.white,
    boxShadow: '0px 1px 4px rgba(0,0,0,0.45)',
  },
});
