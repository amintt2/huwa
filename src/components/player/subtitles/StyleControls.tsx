// Subtitle style controls, shared by the settings screen and the player's quick sheet.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';

import { FilterChip } from '@/components/states';
import { Txt } from '@/components/ui';
import {
  BG_OPACITIES,
  OUTLINE_COLORS,
  OUTLINE_LEVELS,
  POSITION_LEVELS,
  SHADOW_LEVELS,
  SIZE_LEVELS,
  TEXT_COLORS,
  setSubtitlePrefs,
  type Background,
  type SubtitlePrefs,
} from '@/subtitles/prefs';
import { C, R, S } from '@/theme/tokens';

import { SUBTITLE_FONTS, fontStyle, useSubtitleFonts } from './fonts';

export function Field({ title, children, hint }: { title: string; children: ReactNode; hint?: string }) {
  return (
    <View style={{ gap: S.sm }}>
      <Txt v="caption">{title}</Txt>
      {children}
      {hint ? <Txt v="small" style={{ fontSize: 12 }}>{hint}</Txt> : null}
    </View>
  );
}

/** Horizontal chips (scrolls when `scroll`, wraps otherwise). */
export function Chips<T extends string | number>({
  options,
  value,
  onPick,
  scroll,
}: {
  options: { key: T; label: string }[];
  value: T;
  onPick: (k: T) => void;
  scroll?: boolean;
}) {
  const chips = options.map((o) => <FilterChip key={String(o.key)} label={o.label} selected={o.key === value} onPress={() => onPick(o.key)} />);
  return scroll ? (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
      {chips}
    </ScrollView>
  ) : (
    <View style={styles.wrap}>{chips}</View>
  );
}

export function Swatches({ colors, value, onPick }: { colors: readonly { label: string; value: string }[]; value: string; onPick: (v: string) => void }) {
  return (
    <View style={styles.wrap}>
      {colors.map((c) => {
        // A local, not `c.value` in the style: Reanimated's Babel plugin flags `.value` in inline styles.
        const hex = c.value;
        const on = hex.toLowerCase() === value.toLowerCase();
        return (
          <Pressable
            key={c.value}
            onPress={() => onPick(c.value)}
            accessibilityRole="button"
            accessibilityLabel={c.label}
            accessibilityState={{ selected: on }}
            hitSlop={4}
            style={[styles.swatch, on && styles.swatchOn]}>
            <View style={[styles.swatchDot, { backgroundColor: hex }]}>
              {on && <Ionicons name="checkmark" size={16} color={isLight(hex) ? '#000' : '#fff'} />}
            </View>
          </Pressable>
        );
      })}
    </View>
  );
}

const isLight = (hex: string) => {
  const v = parseInt(hex.slice(1), 16);
  return ((v >> 16) & 255) * 0.299 + ((v >> 8) & 255) * 0.587 + (v & 255) * 0.114 > 150;
};

export function SwitchLine({ label, hint, value, onChange }: { label: string; hint?: string; value: boolean; onChange: (v: boolean) => void }) {
  return (
    <View style={styles.switchRow}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" style={{ fontSize: 14 }}>{label}</Txt>
        {hint ? <Txt v="small" style={{ fontSize: 12 }}>{hint}</Txt> : null}
      </View>
      <Switch value={value} onValueChange={onChange} accessibilityLabel={label} trackColor={{ true: C.accent, false: C.elevated }} thumbColor={C.white} />
    </View>
  );
}

/** Font list: each name is drawn in its own font. */
export function FontPicker({ value, onPick, compact }: { value: SubtitlePrefs['font']; onPick: (id: SubtitlePrefs['font']) => void; compact?: boolean }) {
  const fonts = useSubtitleFonts(SUBTITLE_FONTS.map((f) => f.id));
  if (compact) {
    return (
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm }}>
        {SUBTITLE_FONTS.map((f) => {
          const on = f.id === value;
          return (
            <Pressable key={f.id} onPress={() => onPick(f.id)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={f.label}
              style={[styles.fontChip, on && styles.fontChipOn]}>
              <Text style={[{ color: on ? C.accentText : C.text, fontSize: 15 }, fontStyle({ kind: 'app', id: f.id }, true, false, fonts)]}>{f.label}</Text>
            </Pressable>
          );
        })}
      </ScrollView>
    );
  }
  return (
    <View style={styles.fontList}>
      {SUBTITLE_FONTS.map((f, i) => {
        const on = f.id === value;
        return (
          <Pressable key={f.id} onPress={() => onPick(f.id)} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={`${f.label}, ${f.hint}`}
            style={({ pressed }) => [styles.fontRow, i > 0 && styles.fontRowLine, pressed && { opacity: 0.6 }]}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[{ color: C.text, fontSize: 18 }, fontStyle({ kind: 'app', id: f.id }, true, false, fonts)]}>{f.label}</Text>
              <Txt v="small" style={{ fontSize: 12 }}>{f.hint}</Txt>
            </View>
            <Text style={[{ color: C.text2, fontSize: 16 }, fontStyle({ kind: 'app', id: f.id }, false, false, fonts)]}>Àé ç 星</Text>
            <Ionicons name={on ? 'checkmark-circle' : 'ellipse-outline'} size={22} color={on ? C.accentText : C.text2} />
          </Pressable>
        );
      })}
    </View>
  );
}

const BACKGROUNDS: { key: Background; label: string }[] = [
  { key: 'none', label: 'Aucun' },
  { key: 'box', label: 'Boîte' },
  { key: 'band', label: 'Bande' },
];

/** Every style setting. `compact`: one-line scrolling chips (player sheet). */
export function StyleControls({ prefs, compact }: { prefs: SubtitlePrefs; compact?: boolean }) {
  const set = setSubtitlePrefs;
  const idx = <T extends { label: string }>(list: readonly T[]) => list.map((l, i) => ({ key: i, label: l.label }));
  return (
    <View style={{ gap: S.lg }}>
      <Field title="Police">
        <FontPicker value={prefs.font} onPick={(font) => set({ font })} compact={compact} />
      </Field>
      <Field title="Taille">
        <Chips scroll={compact} options={idx(SIZE_LEVELS)} value={prefs.size} onPick={(size) => set({ size })} />
      </Field>
      {!compact && (
        <Field title="Couleur du texte">
          <Swatches colors={TEXT_COLORS} value={prefs.color} onPick={(color) => set({ color })} />
        </Field>
      )}
      <Field title="Contour">
        <Chips scroll={compact} options={idx(OUTLINE_LEVELS)} value={prefs.outline} onPick={(outline) => set({ outline })} />
        {!compact && prefs.outline > 0 && <Swatches colors={OUTLINE_COLORS} value={prefs.outlineColor} onPick={(outlineColor) => set({ outlineColor })} />}
      </Field>
      {!compact && (
        <Field title="Ombre">
          <Chips options={idx(SHADOW_LEVELS)} value={prefs.shadow} onPick={(shadow) => set({ shadow })} />
        </Field>
      )}
      <Field title="Fond">
        <Chips scroll={compact} options={BACKGROUNDS} value={prefs.background} onPick={(background) => set({ background })} />
        {!compact && prefs.background !== 'none' && (
          <Chips
            options={BG_OPACITIES.map((o) => ({ key: o, label: `${Math.round(o * 100)} %` }))}
            value={prefs.bgOpacity}
            onPick={(bgOpacity) => set({ bgOpacity })}
          />
        )}
      </Field>
      <Field title="Position">
        <Chips scroll={compact} options={idx(POSITION_LEVELS)} value={prefs.position} onPick={(position) => set({ position })} />
      </Field>
      <View style={{ gap: S.md }}>
        <SwitchLine label="Texte en gras" value={prefs.bold} onChange={(bold) => set({ bold })} />
        <SwitchLine
          label="Respecter le style de la vidéo"
          hint="Polices, couleurs et positions des fichiers ASS des fansubs. Désactivé : ton style partout (les panneaux positionnés gardent le leur)."
          value={prefs.respectAss}
          onChange={(respectAss) => set({ respectAss })}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  swatch: { width: 38, height: 38, borderRadius: 19, padding: 3, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: C.accentText },
  swatchDot: { flex: 1, borderRadius: 16, alignItems: 'center', justifyContent: 'center', borderWidth: StyleSheet.hairlineWidth, borderColor: C.borderStrong },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  fontList: { borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  fontRow: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 58, paddingHorizontal: S.lg, paddingVertical: 10 },
  fontRowLine: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  fontChip: {
    minHeight: 38, paddingHorizontal: 14, justifyContent: 'center', borderRadius: R.pill,
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  fontChipOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
});
