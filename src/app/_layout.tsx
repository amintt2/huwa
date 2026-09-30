import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { hydrateAddons } from '@/addons/registry';
import { loadCatalog } from '@/data/anilist';
import { useHydrated } from '@/store/store';
import { C } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync();

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.surface, primary: C.accent, text: C.text, border: C.border },
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
  const ready = hydrated && catalogReady;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="anime/[id]" />
        <Stack.Screen name="manhwa/[id]" />
        <Stack.Screen name="watch/[id]" options={{ contentStyle: { backgroundColor: C.black } }} />
        <Stack.Screen name="read/[id]" options={{ contentStyle: { backgroundColor: C.black } }} />
        <Stack.Screen
          name="comments"
          options={{
            presentation: 'formSheet',
            sheetAllowedDetents: [0.75, 1],
            sheetGrabberVisible: true,
            sheetCornerRadius: 28,
            contentStyle: { backgroundColor: C.surface },
          }}
        />
      </Stack>
    </ThemeProvider>
  );
}
