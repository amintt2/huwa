// The browser node could not write to IndexedDB (quota, private mode, eviction): small, dismissible.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';

import { WARN } from '@/components/social';
import { Txt } from '@/components/ui';
import { useWebSession } from '@/p2p/web/login';
import { C, R, S } from '@/theme/tokens';

import { LOGIN_WIDTH } from './parts';

function text(e: { code: string; message: string }) {
  if (e.code === 'QUOTA_EXCEEDED')
    return 'Espace de stockage plein : libère de l’espace sur cet ordinateur ou dans les réglages du navigateur, sinon tes dernières modifications ne seront pas enregistrées.';
  return 'Huwa n’arrive pas à enregistrer sur cet ordinateur. Tes dernières modifications pourraient être perdues au prochain chargement.';
}

export function StorageErrorBanner({ style }: { style?: StyleProp<ViewStyle> }) {
  const { storageError } = useWebSession();
  const [dismissed, setDismissed] = useState<string>();
  const id = storageError ? `${storageError.code}:${storageError.message}` : undefined;
  if (!storageError || dismissed === id) return null;
  return (
    <View style={[styles.wrap, style]} accessibilityRole="alert" accessibilityLiveRegion="polite">
      <View style={styles.banner}>
        <Ionicons name="warning-outline" size={16} color={WARN} style={{ marginTop: 1 }} />
        <Txt v="small" color={C.text} style={{ flex: 1, lineHeight: 18 }}>{text(storageError)}</Txt>
        <Pressable onPress={() => setDismissed(id)} accessibilityRole="button" accessibilityLabel="Masquer" hitSlop={10} style={({ pressed }) => [styles.close, pressed && { opacity: 0.6 }]}>
          <Ionicons name="close" size={16} color={C.text2} />
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center', paddingHorizontal: S.lg, paddingVertical: S.sm },
  banner: {
    width: '100%', maxWidth: LOGIN_WIDTH * 2, flexDirection: 'row', alignItems: 'flex-start', gap: S.sm, padding: S.md,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: '#2A2414', borderWidth: 1, borderColor: 'rgba(255,200,87,0.35)',
  },
  close: { width: 28, height: 28, alignItems: 'center', justifyContent: 'center', marginTop: -5, marginRight: -6 },
});
