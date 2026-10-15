// "Installer l'app" on the web, per platform (rules: ./install-suggest.ts):
// · `InstallBanner`: discreet card on the home page, after a few seconds on a first visit, at once
//   on the next ones; "Plus tard" hides it for 30 days; never once installed.
// · `InstallRow`: the permanent entry in Réglages → Application.
// · `InstallDialog`: the per-platform guide both open (APK how-to, illustrated iOS steps, PWA).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import Animated, { FadeInDown, FadeOutDown } from 'react-native-reanimated';
import QRCode from 'react-native-qrcode-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Row } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { C, R, S, SHADOW } from '@/theme/tokens';
import type { LatestRelease } from '@/updates/release';

import { useWebConfig } from './config';
import { WebDialog } from './dialog';
import {
  androidAbis,
  apkDownload,
  bannerDelay,
  detectPlatform,
  dismissBanner,
  LANDING_PATH,
  OBTAINIUM_URL,
  parseBannerState,
  recordVisit,
  RELEASES_API,
  RELEASES_URL,
  suggestInstall,
  type BannerState,
  type InstallEnv,
  type InstallSuggestion,
} from './install-suggest';
import { isStandalone, promptInstall, useCanInstall, useUpdateAvailable } from './pwa';
import { WIDE, useWindowSize } from './viewport';

type IconName = keyof typeof Ionicons.glyphMap;

// ---------- environment ----------

type UAData = { platform?: string; mobile?: boolean; getHighEntropyValues?: (h: string[]) => Promise<{ architecture?: string; bitness?: string }> };

function uaData(): UAData | null {
  if (typeof navigator === 'undefined') return null;
  return (navigator as Navigator & { userAgentData?: UAData }).userAgentData ?? null;
}

export function readInstallEnv(): InstallEnv {
  if (typeof navigator === 'undefined') return { userAgent: '' };
  return { userAgent: navigator.userAgent, uaData: uaData(), platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints, standalone: isStandalone() };
}

/** What to suggest in this browser right now (follows `beforeinstallprompt` / `appinstalled`). */
export function useInstallSuggestion(): InstallSuggestion {
  const canPrompt = useCanInstall();
  const platform = useMemo(() => detectPlatform(readInstallEnv()), []);
  // `appinstalled` clears the prompt: re-read the display mode then.
  return useMemo(() => suggestInstall({ ...platform, standalone: isStandalone() }, canPrompt), [platform, canPrompt]);
}

// ---------- Android APK link (GitHub "latest release", cached for this tab) ----------

type Apk = { url: string; version?: string; direct: boolean };
const APK_CACHE = 'huwa/install/apk/v1';
let apkPromise: Promise<Apk> | null = null;

function fetchApk(): Promise<Apk> {
  apkPromise ??= (async () => {
    try {
      const cached = JSON.parse(sessionStorage.getItem(APK_CACHE) ?? 'null') as (Apk & { at: number }) | null;
      if (cached && Date.now() - cached.at < 6 * 3600_000 && typeof cached.url === 'string') return cached;
    } catch {}
    let hints: { architecture?: string; bitness?: string } | null = null;
    try {
      hints = (await uaData()?.getHighEntropyValues?.(['architecture', 'bitness'])) ?? null;
    } catch {}
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 5000);
    try {
      const res = await fetch(RELEASES_API, { headers: { Accept: 'application/vnd.github+json' }, signal: ctrl.signal });
      const apk = apkDownload(res.ok ? ((await res.json()) as LatestRelease) : null, androidAbis(hints));
      try {
        sessionStorage.setItem(APK_CACHE, JSON.stringify({ ...apk, at: Date.now() }));
      } catch {}
      return apk;
    } catch {
      return { url: RELEASES_URL, direct: false };
    } finally {
      clearTimeout(timer);
    }
  })();
  return apkPromise;
}

function useApk(enabled: boolean): Apk {
  const [apk, setApk] = useState<Apk>({ url: RELEASES_URL, direct: false });
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    void fetchApk().then((a) => alive && setApk(a));
    return () => {
      alive = false;
    };
  }, [enabled]);
  return apk;
}

const open = (url: string) => {
  if (typeof window !== 'undefined') window.open(url, '_blank', 'noopener');
};
/** A direct APK link downloads in place (no stray tab); the release page opens in a new tab. */
const download = (apk: Apk) => {
  if (typeof window === 'undefined') return;
  if (apk.direct) window.location.assign(apk.url);
  else open(apk.url);
};
/** The old landing page (AltStore PAL, sideload…), served by the instance outside the app. */
const goLanding = () => {
  if (typeof window !== 'undefined') window.location.assign(LANDING_PATH);
};

// ---------- copy per platform ----------

function bannerCopy(s: InstallSuggestion): { icon: IconName; title: string; body: string; action: string } {
  switch (s.kind) {
    case 'android-apk':
      return { icon: 'logo-android', title: 'Installer l’app Android', body: 'L’app complète : lecteur natif, téléchargements, notifications.', action: 'Installer l’app Android' };
    case 'ios-home-screen':
      return { icon: 'add-circle', title: 'Ajoute Huwa à l’écran d’accueil', body: 'Une icône, le plein écran, tes données gardées.', action: 'Ajouter à l’écran d’accueil' };
    default:
      return { icon: 'desktop-outline', title: 'Installer Huwa', body: 'Une fenêtre à part et une icône sur ton ordinateur.', action: 'Installer Huwa' };
  }
}

// ---------- guide dialog ----------

export function InstallDialog({ visible, onClose }: { visible: boolean; onClose: () => void }) {
  const s = useInstallSuggestion();
  const { height } = useWindowSize();
  const label = s.kind === 'android-apk' ? 'Installer l’app Android' : s.kind === 'ios-home-screen' ? 'Ajouter à l’écran d’accueil' : 'Installer Huwa';
  return (
    <WebDialog visible={visible} onClose={onClose} label={label} width={480}>
      {/* Taller than a phone screen: the guide scrolls, "Fermer" stays. */}
      <ScrollView style={{ maxHeight: Math.max(280, height * 0.78 - 90) }} contentContainerStyle={{ gap: S.lg }} showsVerticalScrollIndicator={false}>
      {s.kind === 'android-apk' ? (
        <AndroidGuide />
      ) : s.kind === 'ios-home-screen' ? (
        <IOSGuide browser={s.browser} />
      ) : s.kind === 'desktop-pwa' ? (
        <DesktopGuide canPrompt={s.canPrompt} browser={s.browser} onDone={onClose} />
      ) : (
        <Installed />
      )}
      </ScrollView>
      <Button variant="plain" label="Fermer" onPress={onClose} />
    </WebDialog>
  );
}

function Head({ icon, title, body }: { icon: IconName; title: string; body: string }) {
  return (
    <View style={{ gap: S.md }}>
      <View style={styles.badge}>
        <Ionicons name={icon} size={24} color={C.accentText} />
      </View>
      <View style={{ gap: S.xs }}>
        <Txt v="title" accessibilityRole="header">{title}</Txt>
        <Txt v="body" color={C.body}>{body}</Txt>
      </View>
    </View>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <View style={styles.step}>
      <View style={styles.stepNum}>
        <Txt v="footnote" color={C.accentText} style={{ fontWeight: '800' }}>{n}</Txt>
      </View>
      <View style={{ flex: 1, gap: S.sm }}>{children}</View>
    </View>
  );
}

function AndroidGuide() {
  const apk = useApk(true);
  const canPrompt = useCanInstall();
  return (
    <>
      <Head icon="logo-android" title="Installer l’app Android" body="L’app complète, gratuite et open source, depuis la dernière version publiée sur GitHub." />
      <Button large icon="download-outline" label={apk.direct ? `Télécharger l’APK${apk.version ? ` (${apk.version})` : ''}` : 'Ouvrir la page de téléchargement'} onPress={() => download(apk)} />
      <View style={{ gap: S.md }}>
        <Step n={1}><Txt v="body" color={C.body}>Télécharge le fichier <Txt v="label">.apk</Txt>, puis ouvre-le depuis la notification de téléchargement.</Txt></Step>
        <Step n={2}><Txt v="body" color={C.body}>Si Android bloque l’installation : <Txt v="label">Paramètres</Txt> → <Txt v="label">Autoriser cette source</Txt> pour ton navigateur, puis reviens en arrière.</Txt></Step>
        <Step n={3}><Txt v="body" color={C.body}>Touche <Txt v="label">Installer</Txt>. Huwa te préviendra des mises à jour.</Txt></Step>
      </View>
      <View style={styles.aside}>
        <Txt v="label">Mises à jour automatiques</Txt>
        <Txt v="small" color={C.text2}>Avec Obtainium, chaque nouvelle version s’installe sans repasser par ici.</Txt>
        <Button small variant="soft" label="Ajouter à Obtainium" onPress={() => window.location.assign(OBTAINIUM_URL)} style={{ alignSelf: 'flex-start' }} />
      </View>
      {canPrompt && (
        <Button small variant="plain" label="Ou installer la version web, plus légère" onPress={() => void promptInstall()} />
      )}
    </>
  );
}

/** Safari's toolbar, its share sheet row and the "Ajouter" button, drawn small. */
function IOSGuide({ browser }: { browser: string }) {
  const safari = browser === 'safari';
  return (
    <>
      <Head icon="add-circle" title="Ajouter à l’écran d’accueil" body="Huwa s’ouvre alors comme une app : plein écran, une icône, tes données gardées." />
      <View style={{ gap: S.md }}>
        <Step n={1}>
          <Txt v="body" color={C.body}>Touche <Txt v="label">Partager</Txt>{safari ? ' en bas de Safari (ou ••• puis Partager).' : ' dans la barre d’adresse.'}</Txt>
          <View style={styles.mockBar} aria-hidden>
            <Ionicons name="chevron-back" size={18} color={C.text3} />
            <Ionicons name="chevron-forward" size={18} color={C.text3} />
            <View style={styles.mockHit}>
              <Ionicons name="share-outline" size={20} color={C.accentText} />
            </View>
            <Ionicons name="book-outline" size={18} color={C.text3} />
            <Ionicons name="copy-outline" size={18} color={C.text3} />
          </View>
        </Step>
        <Step n={2}>
          <Txt v="body" color={C.body}>Fais défiler et choisis <Txt v="label">Sur l’écran d’accueil</Txt>.</Txt>
          <View style={styles.mockSheet} aria-hidden>
            <View style={styles.mockRow}>
              <Txt v="small" color={C.text2}>Ajouter aux favoris</Txt>
              <Ionicons name="star-outline" size={16} color={C.text3} />
            </View>
            <View style={[styles.mockRow, styles.mockRowHit]}>
              <Txt v="label">Sur l’écran d’accueil</Txt>
              <Ionicons name="add-circle-outline" size={18} color={C.accentText} />
            </View>
          </View>
        </Step>
        <Step n={3}>
          <Txt v="body" color={C.body}>Garde <Txt v="label">Ouvrir comme app web</Txt> activé et touche <Txt v="label">Ajouter</Txt>.</Txt>
        </Step>
      </View>
      <View style={styles.aside}>
        <Txt v="label">L’app native arrive</Txt>
        <Txt v="small" color={C.text2}>Bientôt sur AltStore PAL dans l’Union européenne. Les utilisateurs avancés peuvent déjà l’installer en sideload (AltStore, SideStore).</Txt>
        <Button small variant="soft" label="Voir les options" icon="arrow-forward" iconRight onPress={goLanding} style={{ alignSelf: 'flex-start' }} />
      </View>
    </>
  );
}

function DesktopGuide({ canPrompt, browser, onDone }: { canPrompt: boolean; browser: string; onDone: () => void }) {
  const url = typeof location === 'undefined' ? 'https://huwa.mciut.fr/get' : `${location.origin}${LANDING_PATH}`;
  return (
    <>
      <Head
        icon="desktop-outline"
        title="Installer Huwa"
        body={
          canPrompt
            ? 'Huwa s’ouvre dans sa propre fenêtre, avec une icône et l’accueil hors ligne.'
            : browser === 'safari'
              ? 'Dans Safari : menu Fichier → Ajouter au Dock.'
              : browser === 'chrome' || browser === 'edge'
                ? 'Icône d’installation à droite de la barre d’adresse, ou menu du navigateur → Installer Huwa.'
                : 'Ton navigateur ne sait pas installer d’app web : Chrome et Edge le proposent.'
        }
      />
      {canPrompt && (
        <Button
          large
          icon="download-outline"
          label="Installer Huwa"
          onPress={() => {
            void promptInstall().then((ok) => ok && onDone());
          }}
        />
      )}
      <View style={[styles.aside, styles.phone]}>
        <View style={styles.qr}>
          <QRCode value={url} size={104} color="#05070D" backgroundColor="#FFFFFF" ecl="M" quietZone={6} />
        </View>
        <View style={{ flex: 1, gap: S.xs }}>
          <Txt v="label">Sur ton téléphone</Txt>
          <Txt v="small" color={C.text2}>Scanne ce code : l’app Android (APK), ou Huwa sur l’écran d’accueil de ton iPhone.</Txt>
        </View>
      </View>
    </>
  );
}

function Installed() {
  return <Head icon="checkmark-circle" title="Huwa est installé" body="Tu utilises déjà l’app. Sur téléphone, l’app Android et l’écran d’accueil de l’iPhone t’attendent aussi." />;
}

// ---------- home banner ----------

const BANNER_KEY = 'huwa/install-banner/v1';
let visitCounted = false;

function readBanner(): BannerState {
  try {
    return parseBannerState(localStorage.getItem(BANNER_KEY));
  } catch {
    return parseBannerState(null);
  }
}

function writeBanner(s: BannerState) {
  try {
    localStorage.setItem(BANNER_KEY, JSON.stringify(s));
  } catch {}
}

/** Home page: the platform's install suggestion, discreetly, at the right moment. */
export function InstallBanner() {
  const suggestion = useInstallSuggestion();
  const config = useWebConfig();
  const update = useUpdateAvailable();
  const insets = useSafeAreaInsets();
  const { width } = useWindowSize();
  const [visible, setVisible] = useState(false);
  const [guide, setGuide] = useState(false);
  const apk = useApk(suggestion.kind === 'android-apk');
  const enabled = config.features.install;

  useEffect(() => {
    if (!enabled) return;
    const now = Date.now();
    let state = readBanner();
    if (!visitCounted) {
      visitCounted = true;
      state = recordVisit(state, now);
      writeBanner(state);
    }
    const delay = bannerDelay(state, suggestion, now);
    if (delay === null) return;
    const t = setTimeout(() => setVisible(true), delay);
    return () => clearTimeout(t);
  }, [enabled, suggestion]);

  const dismiss = () => {
    writeBanner(dismissBanner(readBanner(), Date.now()));
    setVisible(false);
  };
  const act = () => {
    if (suggestion.kind === 'android-apk') {
      // Start the download and keep the how-to on screen for what Android asks next.
      download(apk);
      setGuide(true);
    } else if (suggestion.kind === 'desktop-pwa' && suggestion.canPrompt) {
      void promptInstall().then((ok) => ok && setVisible(false));
    } else {
      setGuide(true);
    }
  };

  const wide = width >= WIDE;
  const copy = bannerCopy(suggestion);
  return (
    <>
      {visible && !update && suggestion.kind !== 'installed' && (
        <Animated.View
          entering={FadeInDown.duration(260)}
          exiting={FadeOutDown.duration(160)}
          role="region"
          aria-label={copy.title}
          style={[styles.banner, wide ? { right: S.xl, bottom: S.xl, width: 400 } : { left: S.md, right: S.md, bottom: insets.bottom + 72 }]}>
          <View style={styles.bannerHead}>
            <View style={styles.bannerIcon}>
              <Ionicons name={copy.icon} size={20} color={C.accentText} />
            </View>
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label">{copy.title}</Txt>
              <Txt v="footnote">{copy.body}</Txt>
            </View>
          </View>
          <View style={styles.bannerActions}>
            <Button small variant="plain" label="Plus tard" onPress={dismiss} accessibilityHint="Ne plus proposer pendant 30 jours" />
            <Button small label={copy.action} onPress={act} style={{ flexShrink: 1 }} />
          </View>
        </Animated.View>
      )}
      <InstallDialog visible={guide} onClose={() => setGuide(false)} />
    </>
  );
}

// ---------- Réglages ----------

export function InstallRow() {
  const s = useInstallSuggestion();
  const [guide, setGuide] = useState(false);
  const detail =
    s.kind === 'installed'
      ? 'Huwa tourne dans sa propre fenêtre.'
      : s.kind === 'android-apk'
        ? 'L’app Android complète (APK), ou Obtainium.'
        : s.kind === 'ios-home-screen'
          ? 'Sur l’écran d’accueil, en deux gestes. L’app native arrive.'
          : s.canPrompt
            ? 'Une fenêtre à part, une icône, l’accueil hors ligne. Et les apps mobiles.'
            : 'Installer la version web, ou les apps mobiles.';
  return (
    <>
      <Row
        icon={s.kind === 'installed' ? 'phone-portrait-outline' : s.kind === 'android-apk' ? 'logo-android' : 'download-outline'}
        label={s.kind === 'installed' ? 'App installée' : 'Installer l’app'}
        detail={detail}
        onPress={() => setGuide(true)}
      />
      <InstallDialog visible={guide} onClose={() => setGuide(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 48, height: 48, borderRadius: 16, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine, boxShadow: SHADOW.inset,
  },
  step: { flexDirection: 'row', gap: S.md, alignItems: 'flex-start' },
  stepNum: {
    width: 24, height: 24, borderRadius: 12, alignItems: 'center', justifyContent: 'center', marginTop: -1,
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
  aside: { gap: S.sm, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
  phone: { flexDirection: 'row', alignItems: 'center', gap: S.lg },
  qr: { borderRadius: R.control, overflow: 'hidden' },
  mockBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', height: 44, paddingHorizontal: S.sm,
    borderRadius: R.control, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border,
  },
  mockHit: {
    width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1.5, borderColor: C.accentText,
  },
  mockSheet: { borderRadius: R.control, backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, overflow: 'hidden' },
  mockRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: S.md, height: 40, borderBottomWidth: 1, borderBottomColor: C.hairline },
  mockRowHit: { backgroundColor: C.accentSoft, borderBottomWidth: 0 },
  banner: {
    position: 'absolute', zIndex: 40, padding: S.md, gap: S.md,
    borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated, borderWidth: 1, borderColor: C.borderStrong,
    boxShadow: `${SHADOW.float}, ${SHADOW.inset}`,
  },
  bannerHead: { flexDirection: 'row', alignItems: 'center', gap: S.md },
  bannerIcon: {
    width: 40, height: 40, borderRadius: 12, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine,
  },
  bannerActions: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: S.sm, flexWrap: 'wrap' },
});
