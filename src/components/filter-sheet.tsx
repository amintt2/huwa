// Generic filter sheet (bottom sheet, medium → large) + active-filter pills + the shared
// search field with its "Filtres" button. The screen describes its filters as sections (chips
// single / multi, year range, steps); values live in the screen. Used by the Anime and Manhwa tabs.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { C, F, R, S, SHADOW, TABULAR } from '@/theme/tokens';

import { Sheet } from './sheet';
import { Button, haptic, Press, Txt } from './ui';

/** Search field + "Filtres" button, kept outside lists so typing never loses focus. */
export function SearchFilterBar({ value, onChange, placeholder, count, onFilters }: { value: string; onChange: (v: string) => void; placeholder: string; count: number; onFilters: () => void }) {
  return (
    <View style={styles.searchRow}>
      <View style={styles.search}>
        <Ionicons name="search" size={17} color={C.text2} />
        <TextInput
          value={value}
          onChangeText={onChange}
          placeholder={placeholder}
          placeholderTextColor={C.text3}
          style={styles.input}
          returnKeyType="search"
          autoCorrect={false}
          clearButtonMode="never"
          accessibilityLabel={placeholder}
        />
        {!!value && (
          <Pressable onPress={() => onChange('')} hitSlop={12} accessibilityRole="button" accessibilityLabel="Effacer la recherche">
            <Ionicons name="close-circle" size={18} color={C.text2} />
          </Pressable>
        )}
      </View>
      <Press onPress={onFilters} scaleTo={0.95} style={[styles.filterBtn, count > 0 && styles.chipOn]} accessibilityRole="button" accessibilityLabel={count ? `Filtres, ${count} actifs` : 'Filtres'}>
        <Ionicons name="options-outline" size={19} color={count ? C.accentText : C.text} />
        {count > 0 && (
          <View style={styles.badge}>
            <Text maxFontSizeMultiplier={1.2} style={styles.badgeText}>{count}</Text>
          </View>
        )}
      </Press>
    </View>
  );
}

export type Option<V> = { value: V; label: string };

export function ChipGroup<V>({ options, selected, onToggle }: { options: Option<V>[]; selected: (v: V) => boolean; onToggle: (v: V) => void }) {
  return (
    <View style={styles.wrap}>
      {options.map((o) => {
        const on = selected(o.value);
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => {
              haptic('select');
              onToggle(o.value);
            }}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[styles.chip, on && styles.chipOn]}>
            {on && <Ionicons name="checkmark" size={14} color={C.accentText} />}
            <Txt v="small" color={on ? C.accentText : C.body} style={{ ...F.semibold }}>{o.label}</Txt>
          </Pressable>
        );
      })}
    </View>
  );
}

/** − value + stepper; `null` shows `emptyLabel` and the first press sets `start`. */
export function Stepper({ label, value, onChange, min, max, start, emptyLabel = 'Tous' }: { label: string; value: number | null; onChange: (v: number | null) => void; min: number; max: number; start: number; emptyLabel?: string }) {
  const step = (d: number) => onChange(value === null ? start : Math.min(max, Math.max(min, value + d)));
  return (
    <View style={styles.stepper}>
      <Txt v="small" style={{ flex: 1 }}>{label}</Txt>
      <Press onPress={() => step(-1)} style={styles.stepBtn} accessibilityLabel={`${label} moins`}>
        <Ionicons name="remove" size={16} color={C.text} />
      </Press>
      <Pressable onPress={() => onChange(null)} accessibilityLabel={`${label} : ${value ?? emptyLabel}, toucher pour effacer`} style={{ minWidth: 64, alignItems: 'center' }}>
        <Txt v="label" tabular color={value === null ? C.text2 : C.text}>{value ?? emptyLabel}</Txt>
      </Pressable>
      <Press onPress={() => step(1)} style={styles.stepBtn} accessibilityLabel={`${label} plus`}>
        <Ionicons name="add" size={16} color={C.text} />
      </Press>
    </View>
  );
}

export function FilterSection({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <View style={{ gap: S.md }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
        <Txt v="caption">{title}</Txt>
        {right}
      </View>
      {children}
    </View>
  );
}

export function FilterSheet({
  visible,
  onClose,
  onReset,
  title = 'Filtres',
  applyLabel = 'Voir les résultats',
  children,
}: {
  visible: boolean;
  onClose: () => void;
  onReset: () => void;
  title?: string;
  applyLabel?: string;
  children: ReactNode;
}) {
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={title}
      detents={['medium', 'large']}
      contentGap={S.xl}
      headerRight={
        <Pressable onPress={onReset} hitSlop={10} accessibilityRole="button" style={({ pressed }) => [{ minHeight: 30, justifyContent: 'center' }, pressed && { opacity: 0.5 }]}>
          <Txt v="small" color={C.accentText} style={F.semibold}>Réinitialiser</Txt>
        </Pressable>
      }
      footer={<Button label={applyLabel} onPress={onClose} />}>
      {children}
    </Sheet>
  );
}

/** Active filters as removable pills, with "Tout effacer" at the end. */
export function FilterPills({ pills, onRemove, onReset }: { pills: { key: string; label: string }[]; onRemove: (key: string) => void; onReset: () => void }) {
  if (!pills.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm, paddingHorizontal: S.lg }}>
      {pills.map((p) => (
        <Pressable key={p.key} onPress={() => onRemove(p.key)} style={[styles.chip, styles.chipOn]} accessibilityRole="button" accessibilityLabel={`Retirer le filtre ${p.label}`}>
          <Txt v="small" color={C.accentText} style={{ ...F.semibold }}>{p.label}</Txt>
          <Ionicons name="close" size={13} color={C.accentText} />
        </Pressable>
      ))}
      <Pressable onPress={onReset} style={styles.chip} accessibilityRole="button">
        <Txt v="small" style={{ ...F.semibold }}>Tout effacer</Txt>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  searchRow: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg },
  search: {
    flex: 1, flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    boxShadow: SHADOW.inset,
  },
  input: { flex: 1, color: C.text, ...F.regular, fontSize: 16, paddingVertical: 10 },
  filterBtn: {
    width: 44, height: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset,
  },
  badge: {
    position: 'absolute', right: -5, top: -5, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 4,
    backgroundColor: C.accent, alignItems: 'center', justifyContent: 'center', borderWidth: 2, borderColor: C.bg,
  },
  badgeText: { color: C.onAccent, fontSize: 10, ...F.bold, ...TABULAR },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 36, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.06)', backgroundColor: C.elevated,
  },
  chipOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.surface, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
});
