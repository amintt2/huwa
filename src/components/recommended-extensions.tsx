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
    <View style={{ gap: S.sm }}>
      {RECOMMENDED.map((r) => {
        const on = installed(r.url);
        return (
          <View key={r.url} style={styles.card}>
            <View style={styles.icon}>
              <Ionicons name={r.icon} size={20} color={C.accentText} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label">{r.name}</Txt>
              <Txt v="small" numberOfLines={2}>{r.what}</Txt>
            </View>
            <Press
              onPress={() => add(r.url)}
              disabled={on || busy === r.url}
              accessibilityRole="button"
              accessibilityLabel={on ? `${r.name} ajouté` : `Ajouter ${r.name}`}
              style={[styles.add, on && styles.added]}>
              {busy === r.url ? (
                <ActivityIndicator color={C.white} />
              ) : on ? (
                <Ionicons name="checkmark" size={18} color={C.accentText} />
              ) : (
                <Txt v="small" color={C.white} style={F.semibold}>Ajouter</Txt>
              )}
            </Press>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  card: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.surface },
  icon: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
  add: { minWidth: 84, minHeight: 36, paddingHorizontal: S.md, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accent },
  added: { backgroundColor: C.accentSoft },
});
