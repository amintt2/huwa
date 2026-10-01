// "Signaler" for an account (DM, profile): publishes the report in the user's block list (the
// P2P moderation that exists), offers to block locally, and lets a human see it: an e-mail to the
// support with a reference. The copy says plainly what happens and what doesn't.
import * as Haptics from 'expo-haptics';
import { Alert } from 'react-native';

import { mailSupport, reportReference, SUPPORT_EMAIL } from '@/config/legal';
import { social } from '@/p2p/hooks';

type Reason = { label: string; val: 'spam' | 'abuse'; text: string };

const REASONS: Reason[] = [
  { label: 'Spam ou arnaque', val: 'spam', text: 'spam ou arnaque' },
  { label: 'Harcèlement ou abus', val: 'abuse', text: 'harcèlement ou abus' },
  { label: 'Contenu illégal ou dangereux', val: 'abuse', text: 'contenu illégal ou dangereux' },
];

export function reportAccount({
  key,
  name,
  where,
  blocked,
  onBlocked,
}: {
  key: string;
  name: string;
  /** "messages privés", "profil"… for the e-mail. */
  where: string;
  blocked: boolean;
  onBlocked?: () => void;
}) {
  const send = (r: Reason) => {
    const ref = reportReference();
    social.report(key, r.val).catch(() => {});
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const mail = () =>
      mailSupport(
        `Signalement ${ref}`,
        [
          `Référence : ${ref}`,
          `Compte signalé : ${name} (${key})`,
          `Motif : ${r.text}`,
          `Où : ${where}`,
          '',
          'Décris ce qui s’est passé (tu peux coller les messages concernés) :',
          '',
        ].join('\n'),
      ).then((ok) => {
        if (!ok) Alert.alert('Aucune app Mail', `Écris à ${SUPPORT_EMAIL} en indiquant la référence ${ref}.`);
      });
    const block = () =>
      social
        .setBlocked(key, true)
        .then(() => onBlocked?.())
        .catch((e) => Alert.alert('Blocage impossible', e instanceof Error ? e.message : String(e)));
    Alert.alert(
      'Signalement enregistré',
      'Il est publié dans ta liste de blocage : ce compte est masqué pour toi et pour ceux qui s’abonnent à ta liste. ' +
        'Huwa n’a pas de serveur ni d’équipe qui lit les échanges : pour qu’un humain examine ce cas, écris au support (référence ' +
        `${ref}) ; il sera lu, mais personne ne peut effacer ce que ce compte a déjà diffusé chez les pairs.`,
      [
        ...(blocked ? [] : [{ text: `Bloquer ${name}`, style: 'destructive' as const, onPress: block }]),
        { text: 'Écrire au support', onPress: mail },
        { text: 'OK', style: 'cancel' as const },
      ],
    );
  };
  Alert.alert(`Signaler ${name}`, 'Pourquoi signales-tu ce compte ?', [
    ...REASONS.map((r) => ({ text: r.label, onPress: () => send(r) })),
    { text: 'Annuler', style: 'cancel' as const },
  ]);
}
