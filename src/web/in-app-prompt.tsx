// "Ouvre Huwa dans ton navigateur": shown once per tab when the page runs in the built-in browser
// of X, Instagram, TikTok… (rules: ./in-app-browser.ts). One button reopens the page in the real
// browser (intent: on Android, x-safari on iOS 17+), the link can be copied, and the manual steps
// cover the apps that block both. "Continuer ici" keeps the page as it is.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Txt } from '@/components/ui';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { WebDialog } from './dialog';
import { detectInAppBrowser, externalBrowserUrl, IN_APP_NAMES, manualSteps, type InAppApp } from './in-app-browser';
import { readInstallEnv } from './install';
import { detectPlatform } from './install-suggest';

const SEEN_KEY = 'huwa/in-app-browser/seen';

/** The app whose built-in browser shows this page, or null (read once per page load). */
let cached: InAppApp | null | undefined;
export function inAppBrowser(): InAppApp | null {
  if (cached === undefined) cached = typeof navigator === 'undefined' ? null : detectInAppBrowser(navigator.userAgent);
  return cached;
}

function seen(): boolean {
  try {
    return sessionStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

export function InAppBrowserPrompt() {
  const app = inAppBrowser();
  const [visible, setVisible] = useState(() => !!app && !seen());
  const [copied, setCopied] = useState(false);
  if (!app) return null;

  const os = detectPlatform(readInstallEnv()).os;
  const name = IN_APP_NAMES[app];
  const href = typeof location === 'undefined' ? '' : location.href;
  const external = externalBrowserUrl(href, os);
  const browser = os === 'ios' ? 'Safari' : 'ton navigateur';

  const close = () => {
    try {
      sessionStorage.setItem(SEEN_KEY, '1');
    } catch {}
    setVisible(false);
  };
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(href);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const limits =
    os === 'android'
      ? 'Ici, l’app Android ne peut pas s’installer, tes données peuvent disparaître à la fermeture et la connexion par clé d’accès ne marche pas.'
      : os === 'ios'
        ? 'Ici, Huwa ne peut pas aller sur l’écran d’accueil, tes données peuvent disparaître à la fermeture et la connexion par clé d’accès ne marche pas.'
        : 'Ici, tes données peuvent disparaître à la fermeture et la connexion par clé d’accès ne marche pas.';

  return (
    <WebDialog visible={visible} onClose={close} label={`Ouvrir Huwa dans ${browser}`} width={460}>
      <View style={{ gap: S.md }}>
        <View style={styles.badge}>
          <Ionicons name="open-outline" size={24} color={C.accentText} />
        </View>
        <View style={{ gap: S.xs }}>
          <Txt v="title" accessibilityRole="header">{name ? `Tu es dans le navigateur de ${name}` : 'Tu es dans un navigateur intégré'}</Txt>
          <Txt v="body" color={C.body}>{limits} Ouvre Huwa dans {browser} pour en profiter pleinement.</Txt>
        </View>
      </View>
      <View style={{ gap: S.sm }}>
        {external && (
          <Button large icon="open-outline" label={os === 'ios' ? 'Ouvrir dans Safari' : 'Ouvrir dans le navigateur'} onPress={() => window.location.assign(external)} />
        )}
        <Button variant={external ? 'ghost' : 'solid'} large={!external} icon={copied ? 'checkmark' : 'copy-outline'} label={copied ? 'Lien copié' : 'Copier le lien'} onPress={() => void copy()} />
      </View>
      <View style={styles.aside}>
        <Txt v="label">Le bouton ne fait rien ?</Txt>
        <Txt v="small" color={C.text2}>{manualSteps(app, os)}</Txt>
        {copied && <Txt v="small" color={C.text2}>Colle ensuite le lien dans la barre d’adresse de {browser}.</Txt>}
      </View>
      <Button variant="plain" label="Continuer ici" onPress={close} />
    </WebDialog>
  );
}

const styles = StyleSheet.create({
  badge: {
    width: 48, height: 48, borderRadius: 16, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine, boxShadow: SHADOW.inset,
  },
  aside: { gap: S.xs, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border },
});
