// "Lier avec mon téléphone" (D7): the browser shows a QR code, the phone scans it and sends a
// sealed pairing invite through the gateway's rendezvous box.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View, useWindowDimensions } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { Button, Txt } from '@/components/ui';
import type { Profile } from '@/p2p/contract';
import { errorCode } from '@/p2p/errors';
import { cancelLogin, linkWithPhone, type LinkProgress } from '@/p2p/web/login';
import { C, R, S, SHADOW } from '@/theme/tokens';

import { useLoginMode } from './login-mode';
import { Card, ErrorLine, LinkButton, LoginFrame, LoginTitle, errorText } from './parts';

/** The phone's invite lives 10 min; the browser stops waiting at the same time. */
const TTL_MS = 10 * 60_000;

const STEPS = [
  'Ouvre Huwa sur ton téléphone.',
  'Va dans Réglages → Sécurité → Lier un navigateur.',
  'Vise ce code. Tu peux aussi le scanner avec l’appareil photo.',
];

const clock = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

type Failure = { kind: 'expired' } | { kind: 'error'; message: string };

export type LinkPhoneQRProps = {
  /** The browser holds the account. */
  onDone: (profile: Profile) => void;
  /** "Utiliser ma phrase de récupération" instead. */
  onUsePhrase?: () => void;
  /** Back to the login hub (the pending link is cancelled by the unmount). */
  onBack?: () => void;
};

export function LinkPhoneQR({ onDone, onUsePhrase, onBack }: LinkPhoneQRProps) {
  const { mode } = useLoginMode();
  const { width } = useWindowDimensions();
  const [attempt, setAttempt] = useState(0);
  const [url, setUrl] = useState<string>();
  const [progress, setProgress] = useState<LinkProgress>();
  const [failure, setFailure] = useState<Failure>();
  const [startedAt, setStartedAt] = useState(() => Date.now());
  const [pairingAt, setPairingAt] = useState<number>();
  const [now, setNow] = useState(() => Date.now());
  /** Cancel of the previous attempt, awaited before the next one starts (same node). */
  const cancelling = useRef<Promise<unknown>>(Promise.resolve());
  const onDoneRef = useRef(onDone);
  useEffect(() => {
    onDoneRef.current = onDone;
  }, [onDone]);

  useEffect(() => {
    const controller = new AbortController();
    let finished = false;
    let alive = true;
    (async () => {
      await cancelling.current.catch(() => {});
      if (!alive) return;
      try {
        const profile = await linkWithPhone({
          mode,
          signal: controller.signal,
          ms: TTL_MS,
          onUrl: (u) => {
            if (!alive) return;
            setUrl(u);
            setStartedAt(Date.now());
          },
          onProgress: (p) => {
            if (!alive) return;
            setProgress(p);
            if (p === 'pairing') setPairingAt(Date.now());
          },
        });
        finished = true;
        if (alive) onDoneRef.current(profile);
      } catch (e) {
        if (!alive || controller.signal.aborted) return;
        const code = errorCode(e);
        if (code === 'cancelled') return;
        setFailure(code === 'expired' ? { kind: 'expired' } : { kind: 'error', message: errorText(e, 'La liaison a échoué.') });
        // The node started for this attempt holds no account: wipe it.
        cancelling.current = cancelLogin() ?? Promise.resolve();
      }
    })();
    return () => {
      alive = false;
      controller.abort();
      if (!finished) cancelling.current = cancelLogin() ?? Promise.resolve();
    };
  }, [attempt, mode]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const left = Math.max(0, Math.round((startedAt + TTL_MS - now) / 1000));
  const expired = failure?.kind === 'expired' || (left === 0 && progress !== 'pairing');
  const pairing = progress === 'pairing' && !failure;
  const elapsed = pairingAt ? Math.max(0, Math.round((now - pairingAt) / 1000)) : 0;
  const size = Math.min(264, Math.max(180, width - 2 * S.lg - 2 * 20));
  const renew = () => {
    setUrl(undefined);
    setProgress(undefined);
    setFailure(undefined);
    setPairingAt(undefined);
    setAttempt((a) => a + 1);
  };

  return (
    <LoginFrame onBack={onBack}>
      <LoginTitle title="Lier avec mon téléphone" subtitle="Ton téléphone envoie ton compte à ce navigateur, chiffré de bout en bout. Rien à taper." />

      <View style={{ alignItems: 'center', gap: S.md }}>
        <View
          style={[styles.qr, { width: size + 32, height: size + 32 }]}
          accessible
          accessibilityRole="image"
          accessibilityLabel={url ? 'QR code de liaison, à scanner avec Huwa sur ton téléphone' : 'Préparation du QR code'}>
          {url && !expired ? (
            <View style={{ opacity: pairing ? 0.15 : 1 }}>
              <QRCode value={url} size={size} color="#05070D" backgroundColor="#FFFFFF" ecl="M" quietZone={12} />
            </View>
          ) : expired ? (
            <Ionicons name="time-outline" size={48} color="#5A6478" />
          ) : (
            <ActivityIndicator color={C.accent} />
          )}
          {pairing ? (
            <View style={styles.overlay}>
              <ActivityIndicator color={C.accent} size="large" />
            </View>
          ) : null}
        </View>

        <View accessibilityLiveRegion="polite" style={{ alignItems: 'center', gap: 2 }}>
          {failure?.kind === 'error' ? null : expired ? (
            <Txt v="label">Ce code a expiré.</Txt>
          ) : pairing ? (
            <>
              <Txt v="label">Liaison en cours…</Txt>
              <Txt v="small" tabular>{`Depuis ${clock(elapsed)} · garde Huwa ouvert sur ton téléphone`}</Txt>
            </>
          ) : (
            <>
              <Txt v="label">{url ? 'En attente du téléphone…' : 'Préparation du code…'}</Txt>
              {url ? <Txt v="small" tabular>{`Valable encore ${clock(left)} · usage unique`}</Txt> : null}
            </>
          )}
        </View>
        {expired ? <Button label="Nouveau code" icon="refresh" onPress={renew} /> : null}
      </View>

      {failure?.kind === 'error' ? (
        <Card tone="danger">
          <ErrorLine text={failure.message} />
          <Button variant="ghost" label="Nouveau code" icon="refresh" onPress={renew} />
        </Card>
      ) : null}

      <Card>
        {STEPS.map((s, i) => (
          <View key={s} style={{ flexDirection: 'row', gap: S.md, alignItems: 'flex-start' }}>
            <View style={styles.num}>
              <Txt v="small" color={C.accentText} tabular>{i + 1}</Txt>
            </View>
            <Txt v="body" style={{ flex: 1, color: C.body }}>{s}</Txt>
          </View>
        ))}
      </Card>

      <Txt v="footnote" color={C.text3} style={{ lineHeight: 17 }}>
        {mode === 'memory'
          ? 'Ordinateur public : rien ne sera enregistré sur cet ordinateur. Ferme l’onglet pour te déconnecter.'
          : 'Ce navigateur apparaîtra dans la liste de tes appareils. Tu pourras le retirer à tout moment.'}
      </Txt>

      {onUsePhrase ? <LinkButton label="Utiliser ma phrase de récupération" onPress={onUsePhrase} /> : null}
    </LoginFrame>
  );
}

const styles = StyleSheet.create({
  qr: {
    alignItems: 'center', justifyContent: 'center', borderRadius: 20, borderCurve: 'continuous',
    backgroundColor: C.white, overflow: 'hidden', boxShadow: SHADOW.float,
  },
  overlay: { ...StyleSheet.absoluteFill, alignItems: 'center', justifyContent: 'center' },
  num: {
    width: 24, height: 24, borderRadius: R.pill, alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft, marginTop: -1,
  },
});
