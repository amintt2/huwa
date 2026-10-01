// Generic filter sheet (native page sheet) + active-filter pills. The screen describes its
// filters as sections (chips single / multi, year range, steps); values live in the screen.
// Used by the Manhwa tab; the Anime tab can reuse it with its own sections.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, F, R, S } from '@/theme/tokens';

import { Button, Press, Txt } from './ui';

export type Option<V> = { value: V; label: string };

export function ChipGroup<V>({ options, selected, onToggle }: { options: Option<V>[]; selected: (v: V) => boolean; onToggle: (v: V) => void }) {
  return (
    <View style={styles.wrap}>
      {options.map((o) => {
        const on = selected(o.value);
        return (
          <Pressable
            key={String(o.value)}
            onPress={() => onToggle(o.value)}
            accessibilityRole="button"
            accessibilityState={{ selected: on }}
            style={[styles.chip, on && styles.chipOn]}>
            {on && <Ionicons name="checkmark" size={13} color={C.accentText} />}
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
        <Txt v="label" color={value === null ? C.text2 : C.text}>{value ?? emptyLabel}</Txt>
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
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.surface }}>
        <View style={styles.sheetHead}>
          <Pressable onPress={onReset} hitSlop={10} accessibilityRole="button" style={{ minWidth: 90 }}>
            <Txt v="small" color={C.accentText} style={F.semibold}>Réinitialiser</Txt>
          </Pressable>
          <Txt v="label" style={{ fontSize: 17 }}>{title}</Txt>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer" style={{ minWidth: 90, alignItems: 'flex-end' }}>
            <Ionicons name="close" size={22} color={C.text} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.xl, paddingBottom: 120 }}>{children}</ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + S.md }]}>
          <Button label={applyLabel} onPress={onClose} />
        </View>
      </View>
    </Modal>
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
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 5, minHeight: 34, paddingHorizontal: S.md,
    borderRadius: R.control, borderCurve: 'continuous', borderWidth: 1, borderColor: C.border, backgroundColor: C.elevated,
  },
  chipOn: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  stepper: { flexDirection: 'row', alignItems: 'center', gap: S.sm, minHeight: 44 },
  stepBtn: { width: 36, height: 36, borderRadius: 18, backgroundColor: C.elevated, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: C.border },
  sheetHead: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: S.lg, paddingTop: S.md, backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
});
