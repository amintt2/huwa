// Logout and passkey-lock helpers shared by WebUnlockScreen and WebSessionCard.
import { useState, type ReactNode } from 'react';
import { View } from 'react-native';

import { Button, Txt } from '@/components/ui';
import { errorCode } from '@/p2p/errors';
import { logout } from '@/p2p/web/login';
import { S } from '@/theme/tokens';

import { Card, errorText } from './parts';

export const LOGOUT_TEXT =
  'Ce navigateur sera retiré de ton compte (retrait signé, visible sur tes autres appareils) et tout ce que Huwa a enregistré ici sera effacé. Pour revenir, il te faudra ton téléphone ou ta phrase de récupération.';

/** French message for a passkey-lock failure, or undefined when the user cancelled. */
export function lockErrorText(e: unknown): string | undefined {
  const name = (e as { name?: string } | null)?.name;
  if (name === 'NotAllowedError' || name === 'AbortError') return undefined;
  switch (errorCode(e)) {
    case 'cancelled':
      return undefined;
    case 'unsupported':
      return 'Les clés d’accès ne sont pas disponibles dans ce navigateur.';
    case 'prf-unavailable':
      return 'Ce gestionnaire de clés d’accès ne peut pas verrouiller Huwa. Essaie avec un autre (trousseau du système, téléphone).';
    case 'no-passkey':
      return 'Aucune clé d’accès ne verrouille cette session.';
    default:
      return errorText(e, 'La clé d’accès n’a pas fonctionné.');
  }
}

const reload = () => {
  if (typeof location !== 'undefined') location.assign('/');
};

/**
 * "Se déconnecter de ce navigateur": signed remove-device, wipe, then a full reload (the app's
 * own caches belong to the account). When the removal could not be signed or sent, says so first.
 */
export function useLogout(): { busy: boolean; error?: string; run: () => void; notice: ReactNode } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [unrevoked, setUnrevoked] = useState(false);

  const run = async () => {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const r = await logout();
      // A removal no peer received was wiped with the rest: it never reached the account.
      if (r.revoked && r.replicated) return reload();
      setUnrevoked(true);
      setBusy(false);
    } catch (e) {
      setError(errorText(e, 'La déconnexion a échoué.'));
      setBusy(false);
    }
  };

  const notice = unrevoked ? (
    <Card tone="warn">
      <View accessibilityRole="alert" style={{ gap: S.xs }}>
        <Txt v="headline">Données effacées</Txt>
        <Txt v="small" style={{ lineHeight: 19 }}>
          Tout ce que Huwa avait enregistré ici est effacé, mais le retrait de ce navigateur n’a pas pu être confirmé par tes autres appareils. Par sécurité, retire-le depuis ton téléphone : Réglages → Sécurité → Appareils liés.
        </Txt>
      </View>
      <Button label="Continuer" onPress={reload} />
    </Card>
  ) : null;

  return { busy, error, run: () => void run(), notice };
}
