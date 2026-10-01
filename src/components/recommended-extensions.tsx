import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { ActivityIndicator, Alert, StyleSheet, View } from 'react-native';

import { RECOMMENDED } from '@/addons/recommended';
import { installAddon, useAddons } from '@/addons/registry';
import { normalizeAddonUrl } from '@/addons/protocol';
import { C, F, R, S } from '@/theme/tokens';

import { Press, Txt } from './ui';

/** One-tap install cards for the recommended (metadata / subtitles only) extensions. */
export function RecommendedExtensions() {
  const addons = useAddons();
  const [busy, setBusy] = useState<string | null>(null);
  const installed = (url: string) => addons.some((a) => a.baseUrl === normalizeAddonUrl(url));

  const add = async (url: string) => {
    if (busy || installed(url)) return;
    setBusy(url);
    try {
      await installAddon(url);
    } catch (e) {
      Alert.alert('Ajout impossible', e instanceof Error ? e.message : 'Extension injoignable, réessaie plus tard.');
    } finally {
      setBusy(null);
    }
  };

  return (
    <View style={styles.card}>
      {RECOMMENDED.map((r, i) => {
        const on = installed(r.url);
        return (
          <View key={r.url} style={[styles.row, i < RECOMMENDED.length - 1 && styles.line]}>
            <View style={styles.icon}>
              <Ionicons name={r.icon} size={20} color={C.accentText} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label" numberOfLines={1}>{r.name}</Txt>
              <Txt v="small" numberOfLines={3} style={{ fontSize: 12, lineHeight: 17 }}>{r.what}</Txt>
            </View>
            <Press
              onPress={() => add(r.url)}
              disabled={on || busy === r.url}
              accessibilityRole="button"
              accessibilityLabel={on ? `${r.name} ajouté` : `Ajouter ${r.name}`}
              style={[styles.add, on && styles.added]}>
              {busy === r.url ? (
                <ActivityIndicator color={C.accentText} />
              ) : on ? (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="checkmark" size={16} color={C.success} />
                  <Txt v="small" color={C.success} style={F.semibold}>Ajoutée</Txt>
                </View>
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
                  <Ionicons name="add" size={16} color={C.accentText} />
                  <Txt v="small" color={C.accentText} style={F.bold}>Ajouter</Txt>
                </View>
              )}
            </Press>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: R.card + 2, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md },
  line: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.borderStrong },
  icon: { width: 44, height: 44, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine },
  add: {
    minWidth: 92, minHeight: 36, paddingHorizontal: S.md, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
  added: { backgroundColor: 'rgba(61,220,151,0.10)', borderColor: 'rgba(61,220,151,0.30)' },
});
