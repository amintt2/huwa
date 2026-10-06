// Friendly crash screen, used as Expo Router's `ErrorBoundary` by the root layout and by the
// player / reader routes. Nothing is lost: progress, lists and settings live in their stores
// (pending writes are flushed right away) and "Réessayer" re-renders the route.
import Ionicons from '@expo/vector-icons/Ionicons';
import type { ErrorBoundaryProps } from 'expo-router';
import { router } from 'expo-router';
import { useEffect } from 'react';
import { Platform, ScrollView, Share, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { flushPendingWrites } from '@/store/persist';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { Button, Txt } from './ui';

/** Plain-text report: what to paste in a bug report (no personal data, just the error). */
export function errorDetail(error: Error) {
  const stack = (error.stack ?? '').split('\n').slice(0, 12).join('\n');
  return [`Huwa · ${Platform.OS} ${String(Platform.Version)}`, `${error.name}: ${error.message}`, stack].filter(Boolean).join('\n\n');
}

export function ErrorScreen({ error, retry }: ErrorBoundaryProps) {
  const insets = useSafeAreaInsets();
  useEffect(() => {
    flushPendingWrites().catch(() => {});
  }, []);
  const detail = errorDetail(error);
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      contentContainerStyle={{ flexGrow: 1, justifyContent: 'center', padding: S.lg, paddingTop: insets.top + S.xl, paddingBottom: insets.bottom + S.xl, gap: S.lg }}>
      <View style={styles.icon}>
        <Ionicons name="bug-outline" size={28} color={C.accentText} />
      </View>
      <Txt v="title" style={{ textAlign: 'center' }} accessibilityRole="header">Oups, cet écran a planté</Txt>
      <Txt v="body" style={{ textAlign: 'center' }}>
        Tes données sont intactes : progression, listes et réglages sont enregistrés. Réessaie ; si ça recommence, envoie-nous le détail.
      </Txt>
      <View style={{ gap: S.sm }}>
        <Button label="Réessayer" icon="refresh" onPress={() => retry()} />
        <Button
          variant="soft"
          label="Copier le détail"
          icon="copy-outline"
          // No clipboard module in the app: the share sheet has « Copier ».
          onPress={() => Share.share({ message: detail }).catch(() => {})}
        />
        {router.canGoBack() && <Button variant="ghost" label="Revenir en arrière" icon="chevron-back" onPress={() => router.back()} />}
      </View>
      <View style={styles.detail}>
        <Txt v="footnote" color={C.text3} selectable style={{ lineHeight: 17, fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }} numberOfLines={8}>
          {`${error.name}: ${error.message}`}
        </Txt>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  icon: {
    alignSelf: 'center', width: 64, height: 64, borderRadius: 32, alignItems: 'center', justifyContent: 'center', marginBottom: S.xs,
    backgroundColor: C.elevated, borderWidth: 1, borderColor: C.accentLine, boxShadow: `0px 0px 0px 10px rgba(47,107,235,0.10), ${SHADOW.inset}`,
  },
  detail: { padding: S.md, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
});
