// Generic filter sheet + active-filter pills. Content-agnostic: the screen describes its groups
// (single / multi choice chips), the sheet renders them, with "Réinitialiser" and a result button.
// iOS: native page sheet (swipe down to close). Shared shape for the Anime and Manhwa catalogs.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Modal, Pressable, ScrollView, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { C, F, R, S } from '@/theme/tokens';

import { Button, Txt } from './ui';

export type FilterOption<V extends string | number> = { value: V; label: string };

export type FilterGroup =
  | { id: string; title: string; kind: 'multi'; options: FilterOption<string>[]; value: string[]; onChange: (v: string[]) => void }
  | { id: string; title: string; kind: 'single'; options: FilterOption<string | number>[]; value: string | number | null; onChange: (v: string | number | null) => void; allowNone?: boolean; noneLabel?: string };

export function FilterSheet({
  visible, title = 'Filtres', groups, onClose, onReset, applyLabel = 'Voir les résultats',
}: {
  visible: boolean;
  title?: string;
  groups: FilterGroup[];
  onClose: () => void;
  onReset: () => void;
  applyLabel?: string;
}) {
  const insets = useSafeAreaInsets();
  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.surface }}>
        <View style={styles.header}>
          <Pressable onPress={onReset} hitSlop={10} accessibilityRole="button" accessibilityLabel="Réinitialiser les filtres">
            <Txt v="label" color={C.accentText} style={{ fontSize: 15 }}>Réinitialiser</Txt>
          </Pressable>
          <Txt v="label" style={{ fontSize: 17, ...F.bold }}>{title}</Txt>
          <Pressable onPress={onClose} hitSlop={10} accessibilityRole="button" accessibilityLabel="Fermer">
            <Ionicons name="close-circle" size={28} color={C.text2} />
          </Pressable>
        </View>
        <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.xl, paddingBottom: S.xxl * 3 }}>
          {groups.map((g) => (
            <View key={g.id} style={{ gap: S.md }}>
              <Txt v="caption" color={C.text2}>{g.title}</Txt>
              <View style={styles.wrap}>
                {g.kind === 'single' && g.allowNone && (
                  <Choice label={g.noneLabel ?? 'Tous'} on={g.value == null} onPress={() => g.onChange(null)} />
                )}
                {g.options.map((o) => {
                  const on = g.kind === 'multi' ? g.value.includes(o.value as string) : g.value === o.value;
                  return (
                    <Choice
                      key={String(o.value)}
                      label={o.label}
                      on={on}
                      onPress={() => {
                        if (g.kind === 'multi') g.onChange(on ? g.value.filter((v) => v !== o.value) : [...g.value, o.value as string]);
                        else g.onChange(on && g.allowNone ? null : o.value);
                      }}
                    />
                  );
                })}
              </View>
            </View>
          ))}
        </ScrollView>
        <View style={[styles.footer, { paddingBottom: insets.bottom + S.md }]}>
          <Button label={applyLabel} onPress={onClose} />
        </View>
      </View>
    </Modal>
  );
}

function Choice({ label, on, onPress }: { label: string; on: boolean; onPress: () => void }) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: on }}
      style={[styles.choice, on && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      {on && <Ionicons name="checkmark" size={14} color={C.accentText} />}
      <Txt v="small" color={on ? C.accentText : C.body} style={F.semibold}>{label}</Txt>
    </Pressable>
  );
}

/** Active filters as removable pills, plus "Tout effacer". Renders nothing when empty. */
export function FilterPills({ pills, onRemove, onReset }: { pills: { key: string; label: string }[]; onRemove: (key: string) => void; onReset: () => void }) {
  if (!pills.length) return null;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: S.sm, paddingHorizontal: S.lg }}>
      {pills.map((p) => (
        <Pressable key={p.key} onPress={() => onRemove(p.key)} accessibilityRole="button" accessibilityLabel={`Retirer le filtre ${p.label}`} style={styles.pill}>
          <Txt v="small" color={C.accentText} style={F.semibold}>{p.label}</Txt>
          <Ionicons name="close" size={14} color={C.accentText} />
        </Pressable>
      ))}
      <Pressable onPress={onReset} accessibilityRole="button" style={[styles.pill, { backgroundColor: 'transparent', borderColor: C.border }]}>
        <Txt v="small" color={C.text2} style={F.semibold}>Tout effacer</Txt>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.md,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.border,
  },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: S.sm },
  choice: {
    flexDirection: 'row', alignItems: 'center', gap: 4, minHeight: 36, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  footer: { position: 'absolute', left: 0, right: 0, bottom: 0, paddingHorizontal: S.lg, paddingTop: S.md, backgroundColor: C.surface, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: C.border },
  pill: {
    flexDirection: 'row', alignItems: 'center', gap: 6, minHeight: 32, paddingHorizontal: S.md, borderRadius: R.pill,
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
});
