// App-wide web prompts, mounted once by the root layout:
// · `ServerParamPrompt`: confirmation for a `?streamingServer=` link (Stremio Web convention).
// · `UpdatePrompt`: "Nouvelle version disponible" when the service worker has a waiting update.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useGlobalSearchParams } from 'expo-router';
import { useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Txt } from '@/components/ui';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { WebDialog } from './dialog';
import { applyUpdate, dismissUpdate, useUpdateAvailable } from './pwa';
import { mixedContent, resolvePending, usePendingServer } from './streaming-server';
import { WIDE, useWindowSize } from './viewport';

export function ServerParamPrompt() {
  // The root layout reads the parameter at startup (takeServerParam); this shows the proposal.
  const url = usePendingServer();
  // expo-router parsed the initial URL before it was cleaned, and writes it back: drop the param
  // from its state too, so a reload does not ask again.
  const { streamingServer } = useGlobalSearchParams<{ streamingServer?: string }>();
  useEffect(() => {
    if (streamingServer !== undefined) router.setParams({ streamingServer: undefined });
  }, [streamingServer]);
  const host = url ? safeHost(url) : '';
  const blocked = url ? mixedContent(url) : false;
  return (
    <WebDialog visible={!!url} onClose={() => resolvePending(false)} label="Utiliser ce serveur de streaming ?">
      <View style={styles.badge}>
        <Ionicons name="server" size={22} color={C.accentText} />
      </View>
      <View style={{ gap: S.sm }}>
        <Txt v="title" accessibilityRole="header">Utiliser ce serveur ?</Txt>
        <Txt v="body" color={C.body}>
          Un lien propose <Txt v="label">{host}</Txt> comme serveur de streaming. Il verra ce que tu regardes : n’accepte que si tu fais confiance à la personne qui l’héberge.
        </Txt>
        <View style={styles.url}>
          <Txt v="footnote" selectable numberOfLines={2} color={C.text2}>{url}</Txt>
        </View>
        {blocked && (
          <Txt v="small" color={C.star}>
            Ce serveur est en http:// : ton navigateur bloquera ses vidéos sur cette page en https://. Demande une adresse en https://.
          </Txt>
        )}
        <Txt v="footnote" color={C.text3}>Tu pourras le changer ou le retirer dans Réglages → Serveur de streaming.</Txt>
      </View>
      <View style={styles.row}>
        <Button variant="ghost" label="Refuser" onPress={() => resolvePending(false)} style={{ flex: 1 }} />
        <Button label="Utiliser ce serveur" onPress={() => resolvePending(true)} style={{ flex: 1 }} />
      </View>
    </WebDialog>
  );
}

function safeHost(url: string) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export function UpdatePrompt() {
  const update = useUpdateAvailable();
  const insets = useSafeAreaInsets();
  const { width } = useWindowSize();
  if (!update) return null;
  const wide = width >= WIDE;
  return (
    <Animated.View
      entering={FadeInDown.duration(240)}
      exiting={FadeOutDown.duration(160)}
      role="status"
      aria-live="polite"
      style={[styles.toast, wide ? { right: S.xl, bottom: S.xl, width: 380 } : { left: S.md, right: S.md, bottom: insets.bottom + 72 }]}>
      <Ionicons name="sparkles" size={18} color={C.accentText} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label">Nouvelle version disponible</Txt>
        <Txt v="footnote">Recharge pour en profiter.</Txt>
      </View>
      <Button small variant="plain" label="Plus tard" onPress={dismissUpdate} />
      <Button small label="Recharger" onPress={applyUpdate} />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 48, height: 48, borderRadius: 16, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine, boxShadow: SHADOW.inset,
  },
  url: { padding: S.sm, paddingHorizontal: S.md, borderRadius: R.control, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  row: { flexDirection: 'row', gap: S.sm },
  toast: {
    position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, paddingLeft: S.lg,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: `${SHADOW.float}, ${SHADOW.inset}`, zIndex: 50,
  },
});
