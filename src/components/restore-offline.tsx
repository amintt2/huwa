// Restore from the phrase found no device of the account online: nothing was changed, the user
// can retry once a device is open, or start a brand-new account instead (explicit choice).
import { Pressable, StyleSheet, View } from 'react-native';
import Ionicons from '@expo/vector-icons/Ionicons';

import { C, F, R, S } from '@/theme/tokens';

import { Button, Txt } from './ui';

export function RestoreOfflineNotice({ busy, onRetry, onNewAccount }: { busy: boolean; onRetry: () => void; onNewAccount?: () => void }) {
  return (
    <View style={styles.card} accessibilityRole="alert">
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
        <View style={styles.icon}>
          <Ionicons name="cloud-offline-outline" size={22} color={C.accentText} />
        </View>
        <Txt v="label" style={{ flex: 1, fontSize: 17 }}>Aucun de tes appareils n’a répondu</Txt>
      </View>
      <Txt v="small" style={{ lineHeight: 18 }}>
        Ton compte n’a pas été modifié. Ouvre Huwa sur un appareil déjà connecté à ce compte (et laisse-le au premier plan), puis réessaie.
      </Txt>
      <Button label={busy ? 'Recherche de tes appareils…' : 'Réessayer'} icon="refresh" onPress={busy ? undefined : onRetry} />
      {onNewAccount ? (
        <Pressable onPress={onNewAccount} disabled={busy} accessibilityRole="button" hitSlop={8} style={{ minHeight: 36, alignItems: 'center', justifyContent: 'center' }}>
          <Txt v="label" color={C.accentText} style={F.semibold}>Créer un nouveau compte à la place</Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.accentLine,
  },
  icon: { width: 44, height: 44, borderRadius: 22, backgroundColor: C.accentSoft, alignItems: 'center', justifyContent: 'center' },
});
