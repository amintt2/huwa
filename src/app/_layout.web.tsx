// Web root layout (docs/WEB_DOCKER_PLAN.md D1, D16). Same providers and boot sequence as
// _layout.tsx, minus what only exists on a phone (Bare worklet, torrent engine, downloads,
// Paperback WebView, notifications, APK updates, iCloud Keychain backup), and with no onboarding
// wall: the catalog is browsable logged out; everything tied to an account stays behind `me`.
// Phase 0 (spike S1): boots and renders. Phase 1 brings the Stremio-like shell and sign-in UI.
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { hydrateAddons } from '@/addons/registry';
import { ToastHost } from '@/components/feedback';
import { OfflineBanner } from '@/components/states';
import { loadCatalog } from '@/data/anilist';
import { installMappingOverlay } from '@/data/mapping-overlay';
import { hydrateLinks } from '@/manga-ext/link';
import { hydrateMangaExt } from '@/manga-ext/registry';
import { useMe, useP2PStatus } from '@/p2p/hooks';
import { useJournalSync } from '@/p2p/sync';
import { useSettingsHydrated } from '@/settings/settings';
import { useListsHydrated } from '@/store/lists';
import { useHydrated } from '@/store/store';
import { C } from '@/theme/tokens';

SplashScreen.preventAutoHideAsync();

export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.surface, primary: C.accent, text: C.text, border: C.border },
};

// No detent form sheets in a browser: plain modals.
const SHEET = { presentation: 'modal' as const, contentStyle: { backgroundColor: C.surface } };

export default function RootLayout() {
  const hydrated = useHydrated();
  const settingsReady = useSettingsHydrated();
  const listsReady = useListsHydrated();
  const [catalogReady, setCatalogReady] = useState(false);
  useEffect(() => {
    hydrateAddons();
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => setCatalogReady(true), 6000);
    Promise.all([installMappingOverlay(), loadCatalog(), hydrateMangaExt().then(hydrateLinks)]).finally(() => {
      clearTimeout(timeout);
      setCatalogReady(true);
    });
    return () => clearTimeout(timeout);
  }, []);
  const p2pState = useP2PStatus().state;
  const me = useMe();
  useJournalSync(hydrated && !!me);
  const ready = hydrated && settingsReady && listsReady && catalogReady && p2pState !== 'starting';

  useEffect(() => {
    if (ready) SplashScreen.hideAsync();
  }, [ready]);

  if (!ready) return null;

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
        {/* Public: catalog, details, search, calendar (D16). */}
        <Stack.Screen name="(tabs)" />
        <Stack.Screen name="anime/[id]" />
        <Stack.Screen name="manhwa/[id]" />
        <Stack.Screen name="search" />
        <Stack.Screen name="calendar" />
        <Stack.Screen name="browse" />
        <Stack.Screen name="about" />
        <Stack.Protected guard={!!me}>
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
          <Stack.Screen name="settings/subtitles" />
          <Stack.Screen name="settings/security" />
          <Stack.Screen name="settings/relays" />
          <Stack.Screen name="settings/phrase" />
          <Stack.Screen name="settings/pair" options={SHEET} />
          <Stack.Screen name="passkey" options={SHEET} />
          <Stack.Screen name="settings/moderation" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/stats" />
          <Stack.Screen name="settings/delete-account" />
          <Stack.Screen name="addons" />
          <Stack.Screen name="manga-sources" />
          <Stack.Screen name="paperback" options={{ animation: 'none' }} />
          <Stack.Screen name="source-section" />
          <Stack.Screen name="extension" />
          <Stack.Screen name="extension-add" options={SHEET} />
          <Stack.Screen name="addon" options={SHEET} />
          <Stack.Screen name="install" options={SHEET} />
          <Stack.Screen name="pack" options={SHEET} />
          <Stack.Screen name="pack-create" />
          <Stack.Screen name="addon-catalog" />
          <Stack.Screen name="debrid" />
          <Stack.Screen name="discover" />
          <Stack.Screen name="meta/[id]" />
          <Stack.Screen name="downloads" />
          <Stack.Screen name="import" />
          <Stack.Screen name="offline" />
          <Stack.Screen name="lists" />
          <Stack.Screen name="list/[id]" />
          <Stack.Screen name="list-picker" options={SHEET} />
          <Stack.Screen name="mapping" options={SHEET} />
          <Stack.Screen name="anilist-auth" options={{ animation: 'none' }} />
        </Stack.Protected>
        <Stack.Protected guard={!me}>
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
      <OfflineBanner />
      <ToastHost />
    </ThemeProvider>
  );
}
