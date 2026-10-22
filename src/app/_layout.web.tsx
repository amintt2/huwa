// Web root layout (docs/WEB_DOCKER_PLAN.md D1, D16, P1). Same providers and boot sequence as
// _layout.tsx, minus what only exists on a phone (Bare worklet, torrent engine, downloads,
// Paperback WebView, notifications, APK updates, iCloud Keychain backup), and with no onboarding
// wall: the catalog is browsable logged out.
//
// · Shell: Stremio-like rail + top bar from 768 px around the whole stack (src/web/shell.tsx).
// · Signed out, the routes that need an account fall in two groups:
//   - "gated" (play, read, comment, extensions): reachable, but they only show the sign-in sheet
//     over the page they were opened from (transparent presentation + src/web/sign-in.tsx);
//   - the rest of the account screens stay behind Stack.Protected.
// · Runtime config (/huwa-config.json), `?streamingServer=` confirmation, service-worker update
//   prompt, persistent storage request.
// · Inside the built-in browser of X, Instagram, TikTok…: "Ouvre Huwa dans ton navigateur"
//   (src/web/in-app-prompt.tsx).
import { DarkTheme, Stack, ThemeProvider } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';

import { hydrateAddons } from '@/addons/registry';
import { ToastHost } from '@/components/feedback';
import { OfflineBanner } from '@/components/states';
import { DiscordInviteCard } from '@/components/discord-invite';
import { PhraseBackupHost, StorageErrorBanner, WebUnlockScreen, usePendingBackup } from '@/components/web-login';
import { useWebSession } from '@/p2p/web/login';
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
import { loadWebConfig, useWebConfig } from '@/web/config';
import { InAppBrowserPrompt } from '@/web/in-app-prompt';
import { ServerParamPrompt, UpdatePrompt } from '@/web/prompts';
import { isStandalone, requestPersistence } from '@/web/pwa';
import { WebShell } from '@/web/shell';
import { takeServerParam } from '@/web/streaming-server';

SplashScreen.preventAutoHideAsync();
void loadWebConfig();
// Read (and strip) ?streamingServer= before the router settles on the URL.
takeServerParam();

export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

const theme = {
  ...DarkTheme,
  colors: { ...DarkTheme.colors, background: C.bg, card: C.surface, primary: C.accent, text: C.text, border: C.border },
};

// No detent form sheets in a browser: plain modals.
const SHEET = { presentation: 'modal' as const, contentStyle: { backgroundColor: C.surface } };
// Signed out, a gated route is only its sign-in sheet: the page underneath stays visible.
const GATE = { presentation: 'transparentModal' as const, animation: 'none' as const, contentStyle: { backgroundColor: 'transparent' } };
const BLACK = { contentStyle: { backgroundColor: C.black } };

export default function RootLayout() {
  const hydrated = useHydrated();
  const settingsReady = useSettingsHydrated();
  const listsReady = useListsHydrated();
  const [catalogReady, setCatalogReady] = useState(false);
  const config = useWebConfig();
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
  const session = useWebSession();
  const backupPending = !!usePendingBackup();
  useJournalSync(hydrated && !!me);
  const ready = hydrated && settingsReady && listsReady && catalogReady && p2pState !== 'starting';

  useEffect(() => {
    if (!ready) return;
    SplashScreen.hideAsync();
    // The static boot skeleton of index.html (scripts/web-postexport.mjs): the app draws now.
    if (typeof document !== 'undefined') document.getElementById('huwa-boot-skel')?.remove();
  }, [ready]);

  // Account keys and progress live in IndexedDB: ask the browser to keep them, once there is
  // something to keep (Firefox shows a prompt for this).
  useEffect(() => {
    if (me || isStandalone()) void requestPersistence();
  }, [me]);

  useEffect(() => {
    if (config.instanceName !== 'Huwa' && typeof document !== 'undefined') document.title = `${config.instanceName} · Huwa`;
  }, [config.instanceName]);

  if (!ready) return null;
  // Account locked (passkey / device key): unlock before anything that needs the account.
  if (session.state === 'locked') {
    return (
      <ThemeProvider value={theme}>
        <StatusBar style="light" />
        <WebUnlockScreen />
      </ThemeProvider>
    );
  }

  const gate = (opts?: object) => (me ? opts : GATE);

  return (
    <ThemeProvider value={theme}>
      <StatusBar style="light" />
      <WebShell>
        <Stack screenOptions={{ headerShown: false, contentStyle: { backgroundColor: C.bg } }}>
          {/* Public: catalog, details, search, calendar, settings (D16). */}
          <Stack.Screen name="(tabs)" />
          <Stack.Screen name="anime/[id]" />
          <Stack.Screen name="manhwa/[id]" />
          <Stack.Screen name="search" />
          <Stack.Screen name="calendar" />
          <Stack.Screen name="browse" />
          <Stack.Screen name="about" />
          <Stack.Screen name="settings/index" />
          {/* Gated: the sign-in sheet when signed out. */}
          <Stack.Screen name="watch/[id]" options={gate(BLACK)} />
          <Stack.Screen name="read/[id]" options={gate(BLACK)} />
          <Stack.Screen name="comments" options={gate(SHEET)} />
          <Stack.Screen name="addons" options={gate()} />
          <Stack.Screen name="addon" options={gate(SHEET)} />
          <Stack.Screen name="install" options={gate(SHEET)} />
          <Stack.Screen name="extension-add" options={gate(SHEET)} />
          <Stack.Screen name="pack" options={gate(SHEET)} />
          <Stack.Screen name="manga-sources" options={gate()} />
          <Stack.Protected guard={!!me}>
            <Stack.Screen name="u/[key]" />
            <Stack.Screen name="profile-edit" options={SHEET} />
            <Stack.Screen name="messages" />
            <Stack.Screen name="dm/[key]" />
            <Stack.Screen name="rank" />
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
            <Stack.Screen name="paperback" options={{ animation: 'none' }} />
            <Stack.Screen name="source-section" />
            <Stack.Screen name="extension" />
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
        {/* Survives the onboarding route unmounting right after account creation. */}
        <PhraseBackupHost />
      </WebShell>
      <OfflineBanner />
      <StorageErrorBanner />
      <ToastHost />
      <ServerParamPrompt />
      <UpdatePrompt />
      <InAppBrowserPrompt />
      {/* Once, right after signing in for the first time (after the phrase backup). */}
      {me ? <DiscordInviteCard blocked={backupPending} /> : null}
    </ThemeProvider>
  );
}
