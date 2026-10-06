// Demo mode (store screenshots) must patch storage before anything reads it.
import { isDemo } from '@/demo';
import { DemoRoute } from '@/demo/route';
// An account deleted last session: its P2P store goes before anything opens it.
import { finishPendingDeletion } from '@/settings/delete-account';
import { DarkTheme, Stack, ThemeProvider, router } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState } from 'react-native';

import { hydrateAddons } from '@/addons/registry';
import { isStoreBuild } from '@/config/channel';
import { cloudBackup } from '@/p2p/cloud-backup';
import { registerNativeTorrentEngine } from '@/torrent/register';
import { Onboarding } from '@/components/onboarding';
import { PresearchHost } from '@/components/presearch';
import { DownloadsHost } from '@/downloads/host';
import { OfflineBanner } from '@/components/states';
import { loadCatalog } from '@/data/anilist';
import { installMappingOverlay } from '@/data/mapping-overlay';
import { hydrateLinks } from '@/manga-ext/link';
import { PaperbackHost } from '@/manga-ext/PaperbackHost';
import { CloudflareSheet } from '@/components/cloudflare-sheet';
import { hydrateMangaExt } from '@/manga-ext/registry';
import { useEpisodeNotifications } from '@/notifications/episodes';
import { useMe, useP2PStatus } from '@/p2p/hooks';
import { canCarryAccount, consumePasskeyOffer, usePasskeyOfferPending, usePasskeyRecord } from '@/p2p/passkey';
import { useJournalSync } from '@/p2p/sync';
import { setPendingLink, usePendingLink } from '@/packs/routes';
import { useSettings, useSettingsHydrated } from '@/settings/settings';
import { useListsHydrated } from '@/store/lists';
import { flushPendingWrites, leavesForeground } from '@/store/persist';
import { useHydrated } from '@/store/store';
import { C } from '@/theme/tokens';

finishPendingDeletion();
SplashScreen.preventAutoHideAsync();

// Any crash below the root shows a friendly screen with « Réessayer » (see error-screen.tsx).
export { ErrorScreen as ErrorBoundary } from '@/components/error-screen';

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
  // iOS may kill a suspended app without warning: write pending progress / lists before that.
  useEffect(() => {
    const sub = AppState.addEventListener('change', (s) => {
      if (leavesForeground(s)) flushPendingWrites().catch(() => {});
    });
    return () => sub.remove();
  }, []);
  useEffect(() => {
    hydrateAddons();
    registerNativeTorrentEngine();
    if (!isDemo) cloudBackup.init().catch(() => {});
  }, []);
  useEffect(() => {
    const timeout = setTimeout(() => setCatalogReady(true), 6000);
    // Source links overlay real chapters on catalog series: restore them with the catalog.
    // Franchise-wide chapter ranges and community corrections apply to every series it loads.
    Promise.all([installMappingOverlay(), loadCatalog(), hydrateMangaExt().then(hydrateLinks)]).finally(() => {
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
  // Keep the iCloud Keychain account hint ("Continuer en tant que …") in step with the profile.
  const meName = me?.name;
  const meFingerprint = me?.fingerprint;
  useEffect(() => {
    if (isDemo || !meFingerprint) return;
    cloudBackup.syncHint({ name: meName && meName !== 'moi' ? meName : undefined, fingerprint: meFingerprint }).catch(() => {});
  }, [meName, meFingerprint]);
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
          {/* Card modal, not a detent form sheet: in a detent sheet the scrollable thread and its header
              got broken heights (overlap, then an empty sheet). Swipe down still closes it. */}
          <Stack.Screen name="comments" options={{ presentation: 'modal', contentStyle: { backgroundColor: C.surface } }} />
          <Stack.Screen name="u/[key]" />
          <Stack.Screen name="profile-edit" options={SHEET} />
          <Stack.Screen name="messages" />
          <Stack.Screen name="dm/[key]" />
          <Stack.Screen name="rank" />
          <Stack.Screen name="settings/index" />
          <Stack.Screen name="settings/general" />
          <Stack.Screen name="settings/subtitles" />
          <Stack.Screen name="settings/security" />
          <Stack.Screen name="settings/phrase" />
          <Stack.Screen name="settings/pair" options={SHEET} />
          <Stack.Screen name="passkey" options={{ ...SHEET, sheetAllowedDetents: [0.62, 1] }} />
          <Stack.Screen name="settings/moderation" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/stats" />
          <Stack.Screen name="settings/delete-account" />
          <Stack.Screen name="about" />
          {/* Extensions, packs, debrid and torrent: full flavor only. The App Store build is a
              library app (PLAN.md « Version App Store »); links there are also redirected by
              +native-intent. */}
          <Stack.Protected guard={!isStoreBuild}>
            <Stack.Screen name="addons" />
            <Stack.Screen name="manga-sources" />
            <Stack.Screen name="paperback" options={{ animation: 'none' }} />
            <Stack.Screen name="source-section" />
            <Stack.Screen name="extension" />
            <Stack.Screen name="extension-add" options={{ presentation: 'modal', contentStyle: { backgroundColor: C.surface } }} />
            <Stack.Screen name="addon" options={SHEET} />
            <Stack.Screen name="install" options={SHEET} />
            <Stack.Screen name="pack" options={{ presentation: 'modal', contentStyle: { backgroundColor: C.surface } }} />
            <Stack.Screen name="pack-create" />
            <Stack.Screen name="addon-catalog" />
            <Stack.Screen name="debrid" />
            <Stack.Screen name="discover" />
            <Stack.Screen name="meta/[id]" />
            <Stack.Screen name="downloads" />
          </Stack.Protected>
          <Stack.Screen name="import" />
          <Stack.Screen name="browse" />
          <Stack.Screen name="offline" />
          <Stack.Screen name="search" />
          <Stack.Screen name="calendar" />
          <Stack.Screen name="lists" />
          <Stack.Screen name="list/[id]" />
          <Stack.Screen name="list-picker" options={{ ...SHEET, sheetAllowedDetents: [0.7, 1] }} />
          <Stack.Screen name="mapping" options={{ ...SHEET, sheetAllowedDetents: [0.62, 1] }} />
          <Stack.Screen name="anilist-auth" options={{ animation: 'none' }} />
        </Stack.Protected>
        <Stack.Protected guard={!me}>
          <Stack.Screen name="onboarding" options={{ animation: 'fade' }} />
        </Stack.Protected>
      </Stack>
      {isDemo ? <DemoRoute /> : <EpisodeNotifications />}
      {!isDemo && me ? <PasskeyOffer /> : null}
      {me ? <PendingLink /> : null}
      <OfflineBanner />
      <PaperbackHost />
      <CloudflareSheet />
      {me ? <PresearchHost /> : null}
      {me ? <DownloadsHost /> : null}
    </ThemeProvider>
  );
}

/** Right after creating or restoring an account: propose « Ajoute une clé d’accès » once. */
function PasskeyOffer() {
  const pending = usePasskeyOfferPending();
  const me = useMe();
  const record = usePasskeyRecord(me?.key);
  useEffect(() => {
    if (!pending || !me || record === undefined) return;
    consumePasskeyOffer();
    if (record) return;
    (async () => {
      // Restored an account that already has a passkey (written by another device): nothing to offer.
      const hint = await cloudBackup.loadHint();
      if (hint?.passkeyAt && hint.fingerprint === me.fingerprint) return;
      if (!(await canCarryAccount())) return;
      // Let the protected stack switch from onboarding to the tabs first.
      setTimeout(() => router.push('/passkey'), 700);
    })().catch(() => {});
  }, [pending, me, record]);
  return null;
}

/** A link pasted or scanned during the introduction: opened (on its confirmation screen) once the app is ready. */
function PendingLink() {
  const href = usePendingLink();
  useEffect(() => {
    if (!href) return;
    const timer = setTimeout(() => {
      setPendingLink(undefined);
      router.push(href);
    }, 900);
    return () => clearTimeout(timer);
  }, [href]);
  return null;
}

/** Schedules new-episode notifications and handles taps (needs the navigator mounted). */
function EpisodeNotifications() {
  useEpisodeNotifications();
  return null;
}
