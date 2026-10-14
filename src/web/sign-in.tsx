// Logged-out web (docs/WEB_DOCKER_PLAN.md D16): the catalog is public, everything that needs an
// account — playing, reading, commenting, extensions — asks to sign in first.
//
// · `SignInPanel`: the three ways in. Phase 1 wires them to what exists today (local web profile,
//   pairing scan, recovery phrase); phase 3 replaces the QR one with "Link a browser" (D7).
// · `gated(Screen, reason)`: wraps a protected route. Signed in → the screen. Signed out → the
//   route shows only the sign-in sheet over the page it was opened from (transparent route, see
//   src/app/_layout.web.tsx), and closing the sheet goes back.
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { useCallback, type ComponentType } from 'react';
import { StyleSheet, View } from 'react-native';

import { Button, Txt, type IconName } from '@/components/ui';
import { useMe } from '@/p2p/hooks';
import { C, S, SHADOW } from '@/theme/tokens';

import { WebDialog } from './dialog';

export type SignInReason = 'watch' | 'read' | 'comment' | 'addons' | 'account';

const COPY: Record<SignInReason, { icon: IconName; title: string; text: string }> = {
  watch: {
    icon: 'play',
    title: 'Connecte-toi pour lire',
    text: 'Le catalogue est ouvert à tous. Pour lancer un épisode, Huwa a besoin de ton compte : tes extensions et ton serveur de streaming y sont rangés.',
  },
  read: {
    icon: 'book',
    title: 'Connecte-toi pour lire',
    text: 'Les chapitres viennent des sources de lecture de ton compte. Connecte-toi pour les retrouver ici.',
  },
  comment: {
    icon: 'chatbubbles',
    title: 'Connecte-toi pour commenter',
    text: 'Chaque commentaire est signé par la clé de ton compte et partagé de pair à pair, sans serveur central.',
  },
  addons: {
    icon: 'extension-puzzle',
    title: 'Connecte-toi pour ajouter des extensions',
    text: 'Tes extensions sont liées à ton compte, pour les retrouver sur tous tes appareils.',
  },
  account: {
    icon: 'person',
    title: 'Connecte-toi à Huwa',
    text: 'Ton compte est une clé : elle reste dans ce navigateur, aucun serveur ne la détient.',
  },
};

export const signInCopy = (reason: SignInReason) => COPY[reason];

/** Where each way in leads today. */
export const SIGN_IN_ROUTES = {
  qr: '/onboarding/scan',
  phrase: '/onboarding/restore',
  create: '/onboarding',
} as const;

export function SignInActions({ onNavigate }: { onNavigate?: () => void }) {
  const go = (href: (typeof SIGN_IN_ROUTES)[keyof typeof SIGN_IN_ROUTES]) => {
    onNavigate?.();
    router.push(href);
  };
  return (
    <View style={{ gap: S.sm }}>
      <Button icon="qr-code" label="Lier avec mon téléphone (QR)" onPress={() => go(SIGN_IN_ROUTES.qr)} />
      <Button variant="ghost" icon="key-outline" label="Phrase de récupération" onPress={() => go(SIGN_IN_ROUTES.phrase)} />
      <Button variant="plain" icon="add-circle-outline" label="Créer un compte dans ce navigateur" onPress={() => go(SIGN_IN_ROUTES.create)} />
    </View>
  );
}

export function SignInHeader({ reason, large }: { reason: SignInReason; large?: boolean }) {
  const c = COPY[reason];
  return (
    <View style={{ gap: S.md }}>
      <View style={[styles.badge, large && { width: 64, height: 64, borderRadius: 20 }]}>
        <Ionicons name={c.icon} size={large ? 28 : 22} color={C.accentText} style={c.icon === 'play' ? { marginLeft: 2 } : undefined} />
      </View>
      <View style={{ gap: S.xs }}>
        <Txt v={large ? 'display' : 'title'} accessibilityRole="header">{c.title}</Txt>
        <Txt v="body" color={C.body}>{c.text}</Txt>
      </View>
    </View>
  );
}

/** The sign-in sheet (modal). */
export function SignInSheet({ reason, visible, onClose, inline }: { reason: SignInReason; visible: boolean; onClose: () => void; inline?: boolean }) {
  return (
    <WebDialog visible={visible} onClose={onClose} label={COPY[reason].title} inline={inline}>
      <SignInHeader reason={reason} />
      <SignInActions />
      <Txt v="footnote" color={C.text3}>Une seule session par navigateur : se connecter ici ne connecte personne d’autre.</Txt>
    </WebDialog>
  );
}

function leave() {
  if (router.canGoBack()) router.back();
  else router.replace('/');
}

/** Route body shown to a signed-out visitor: only the sheet, over the previous page. */
function SignInRoute({ reason }: { reason: SignInReason }) {
  const close = useCallback(() => leave(), []);
  return <SignInSheet reason={reason} visible onClose={close} />;
}

/** Protected route: the screen when signed in, the sign-in sheet otherwise. */
export function gated<P extends object>(Screen: ComponentType<P>, reason: SignInReason) {
  function Gated(props: P) {
    const me = useMe();
    return me ? <Screen {...props} /> : <SignInRoute reason={reason} />;
  }
  Gated.displayName = `Gated(${Screen.displayName ?? Screen.name ?? 'Screen'})`;
  return Gated;
}

export function useSignedIn(): boolean {
  return !!useMe();
}

const styles = StyleSheet.create({
  badge: {
    width: 48, height: 48, borderRadius: 16, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine, boxShadow: SHADOW.inset,
  },
});
