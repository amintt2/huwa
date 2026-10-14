// Entry of a logged-out browser (D7): link with the phone (recommended), recovery phrase,
// passkey (where it works, D8), or a new account; plus the "Ordinateur public" choice (D6).
import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { StyleSheet, Switch, View } from 'react-native';

import { Press, Txt, Wordmark, type IconName } from '@/components/ui';
import type { Profile } from '@/p2p/contract';
import { PHRASE_WORDS } from '@/social/identity';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { CreateAccount } from './create-account';
import { useLoginMode } from './login-mode';
import { Card, LinkButton, LoginFrame, passkeyLoginAvailable } from './parts';
import { PasskeyLogin } from './passkey-login';

export type WebLoginHubProps = {
  /** "Lier avec mon téléphone": e.g. router.push('/onboarding/scan'). */
  onLinkPhone: () => void;
  /** "Utiliser ma phrase de récupération": e.g. router.push('/onboarding/restore'). */
  onPhrase: () => void;
  /** A login finished inline (passkey, new account): e.g. router.replace('/'). */
  onDone: (profile: Profile) => void;
  /** "Créer un compte dans ce navigateur" on its own route; default: shown inline by the hub. */
  onCreate?: () => void;
  /** Open on the inline "Créer un compte" step (e.g. `/onboarding?create=1`). */
  startWithCreate?: boolean;
};

function Option({ icon, title, detail, badge, primary, onPress }: { icon: IconName; title: string; detail: string; badge?: string; primary?: boolean; onPress: () => void }) {
  return (
    <Press
      onPress={onPress}
      haptics="light"
      accessibilityRole="button"
      accessibilityLabel={badge ? `${title}, ${badge.toLowerCase()}` : title}
      accessibilityHint={detail}
      style={[styles.option, primary && styles.primary]}>
      <View style={[styles.icon, primary && { backgroundColor: C.accent }]}>
        <Ionicons name={icon} size={20} color={primary ? C.white : C.accentText} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexWrap: 'wrap' }}>
          <Txt v="headline">{title}</Txt>
          {badge ? (
            <View style={styles.badge}>
              <Txt v="caption" color={C.accentText} style={{ fontSize: 10 }}>{badge}</Txt>
            </View>
          ) : null}
        </View>
        <Txt v="small" style={{ lineHeight: 18 }}>{detail}</Txt>
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.text3} />
    </Press>
  );
}

export function WebLoginHub({ onLinkPhone, onPhrase, onDone, onCreate, startWithCreate }: WebLoginHubProps) {
  const { publicComputer, setPublicComputer } = useLoginMode();
  const [creating, setCreating] = useState(!!startWithCreate && !onCreate);
  const passkey = passkeyLoginAvailable();

  const create = () => (onCreate ? onCreate() : setCreating(true));

  if (creating) return <CreateAccount onDone={onDone} onBack={() => setCreating(false)} onHaveAccount={() => setCreating(false)} />;

  return (
    <LoginFrame>
      <View style={{ gap: S.md }}>
        <Wordmark size={30} />
        <Txt v="display" accessibilityRole="header" style={{ fontSize: 28, lineHeight: 33, marginTop: S.sm }}>Connecte-toi à Huwa</Txt>
        <Txt v="body" style={{ fontSize: 16, lineHeight: 23 }}>
          Retrouve ton compte, tes listes et ta communauté dans ce navigateur. Aucun serveur ne détient ta clé.
        </Txt>
      </View>

      <View style={{ gap: S.md }}>
        <Option
          primary
          icon="qr-code-outline"
          title="Lier avec mon téléphone"
          badge="Recommandé"
          detail="Scanne un code avec Huwa sur ton téléphone. Rien à taper."
          onPress={onLinkPhone}
        />
        <Option icon="key-outline" title="Utiliser ma phrase de récupération" detail={`Les ${PHRASE_WORDS} mots notés à la création de ton compte.`} onPress={onPhrase} />
        {passkey ? <PasskeyLogin onDone={onDone} onCreate={create} /> : null}
      </View>

      <Card>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.md }}>
          <Ionicons name="people-outline" size={20} color={C.accentText} />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt v="label">Ordinateur public</Txt>
            <Txt v="small" style={{ lineHeight: 18 }}>Rien n’est enregistré sur cet ordinateur : la session s’efface en fermant l’onglet.</Txt>
          </View>
          <Switch
            value={publicComputer}
            onValueChange={setPublicComputer}
            trackColor={{ false: C.borderStrong, true: C.accent }}
            accessibilityLabel="Ordinateur public : ne rien enregistrer sur cet ordinateur"
          />
        </View>
      </Card>

      <View style={{ gap: S.xs, alignItems: 'center' }}>
        <Txt v="small">Pas encore de compte ?</Txt>
        <LinkButton label="Créer un compte dans ce navigateur" onPress={create} />
      </View>
    </LoginFrame>
  );
}

const styles = StyleSheet.create({
  option: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.raised,
  },
  primary: { borderColor: C.accentLine, backgroundColor: '#0F1A33' },
  icon: {
    width: 40, height: 40, borderRadius: R.control, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.accentSoft, boxShadow: SHADOW.inset,
  },
  badge: { paddingHorizontal: 6, paddingVertical: 2, borderRadius: R.chip, backgroundColor: C.accentSoft },
});
