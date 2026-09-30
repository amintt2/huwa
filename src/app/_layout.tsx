// Demo mode (store screenshots) must patch storage before anything reads it.
import { isDemo } from '@/demo';
import { DemoRoute } from '@/demo/route';
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { hydrateAddons } from '@/addons/registry';
import { cloudBackup } from '@/p2p/cloud-backup';
import { registerNativeTorrentEngine } from '@/torrent/register';
import { Onboarding } from '@/components/onboarding';
import { OfflineBanner } from '@/components/states';
import { loadCatalog } from '@/data/anilist';
import { useEpisodeNotifications } from '@/notifications/episodes';
import { useMe, useP2PStatus } from '@/p2p/hooks';
import { useJournalSync } from '@/p2p/sync';
import { useSettings, useSettingsHydrated } from '@/settings/settings';
import { useListsHydrated } from '@/store/lists';
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
  const settingsReady = useSettingsHydrated();
  const listsReady = useListsHydrated();
  const { onboarded } = useSettings();
  // Hold the splash until the catalog is on screen (cache or network), 6 s max.
  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    hydrateAddons();
    registerNativeTorrentEngine();
    if (!isDemo) cloudBackup.init().catch(() => {});
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
  const ready = hydrated && settingsReady && listsReady && catalogReady && identityKnown;

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  if (!onboarded) {
    return (
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        <Onboarding />
      </ThemeProvider>
    );
  }

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
          <Stack.Screen name="settings/general" />
          <Stack.Screen name="settings/security" />
          <Stack.Screen name="settings/phrase" />
          <Stack.Screen name="settings/pair" options={SHEET} />
          <Stack.Screen name="settings/moderation" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="addons" />
          <Stack.Screen name="debrid" />
          <Stack.Screen name="discover" />
          <Stack.Screen name="meta/[id]" />
          <Stack.Screen name="downloads" />
          <Stack.Screen name="offline" />
          <Stack.Screen name="search" />
          <Stack.Screen name="calendar" />
          <Stack.Screen name="lists" />
          <Stack.Screen name="list/[id]" />
          <Stack.Screen name="list-picker" options={{ ...SHEET, sheetAllowedDetents: [0.7, 1] }} />
          <Stack.Screen name="anilist-auth" options={{ animation: 'none' }} />
        </Stack.Protected>
        <Stack.Protected guard={!me}>
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
      {isDemo ? <DemoRoute /> : <EpisodeNotifications />}
      <OfflineBanner />
    </ThemeProvider>
  );
}

/** Schedules new-episode notifications and handles taps (needs the navigator mounted). */
function EpisodeNotifications() {
  useEpisodeNotifications();
  return null;
}
