import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { hydrateAddons } from '@/addons/registry';
import { loadCatalog } from '@/data/anilist';
import { useMe, useP2PStatus } from '@/p2p/hooks';
import { useJournalSync } from '@/p2p/sync';
import { useHydrated } from '@/store/store';
import { C } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.surface, primary: C.accent, text: C.text, border: C.border },
};

const SHEET = {
  presentation: 'formSheet' as const,
  sheetAllowedDetents: [0.75, 1],
  sheetGrabberVisible: true,
  sheetCornerRadius: 28,
  contentStyle: { backgroundColor: C.surface },
};

export default function RootLayout() {
  const hydrated = useHydrated();
  // Hold the splash until the catalog is on screen (cache or network), 6 s max.
  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    hydrateAddons();
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => setCatalogReady(true), 6000);
    loadCatalog().finally(() => {
      clearTimeout(timeout);
      setCatalogReady(true);
    });
    return () => clearTimeout(timeout);
  }, []);
  // Identity decides between onboarding and the app: wait until the P2P layer has loaded it.
  const p2pState = useP2PStatus().state;
  const me = useMe();
  const identityKnown = p2pState !== 'starting';
  useJournalSync(hydrated && !!me);
  const ready = hydrated && catalogReady && identityKnown;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Protected guard={!!me}>
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="anime/[id]" />
          <Stack.Screen name="manhwa/[id]" />
          <Stack.Screen name="watch/[id]" options={{ contentStyle: { backgroundColor: C.black } }} />
          <Stack.Screen name="read/[id]" options={{ contentStyle: { backgroundColor: C.black } }} />
          <Stack.Screen name="comments" options={SHEET} />
          <Stack.Screen name="u/[key]" />
          <Stack.Screen name="profile-edit" options={SHEET} />
          <Stack.Screen name="messages" />
          <Stack.Screen name="dm/[key]" />
          <Stack.Screen name="rank" />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/security" />
          <Stack.Screen name="settings/phrase" />
          <Stack.Screen name="settings/pair" options={SHEET} />
          <Stack.Screen name="settings/moderation" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="addons" />
        </Stack.Protected>
        <Stack.Protected guard={!me}>
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
    </ThemeProvider>
  );
}
