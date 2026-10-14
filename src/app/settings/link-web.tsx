import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Device from 'expo-device';
import * as Haptics from 'expo-haptics';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Linking, ScrollView, StyleSheet, View } from 'react-native';

import { SheetTitle } from '@/components/screen';
import { DANGER, Empty, Loading } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { useMe, useSecurity } from '@/p2p/hooks';
import { LinkWebError, linkRequestFromParams, parseLinkUrl, relayHost, sendLinkInvite, type LinkWebRequest } from '@/p2p/link-web-phone';
import { C, R, S } from '@/theme/tokens';

type Step = { kind: 'scan' } | { kind: 'confirm'; req: LinkWebRequest } | { kind: 'sending'; req: LinkWebRequest } | { kind: 'sent'; req: LinkWebRequest } | { kind: 'done'; req: LinkWebRequest; name: string } | { kind: 'error'; message: string; req?: LinkWebRequest };

const WAIT_MS = 2 * 60_000;

const message = (e: unknown) => (e instanceof LinkWebError || e instanceof Error ? e.message : 'La liaison a échoué.');

/**
 * Phone side of "Lier avec mon téléphone": opened by the QR code Huwa Web shows
 * (huwa://link-web?k=…&r=…&t=…&n=…, system camera or the scanner below), it sends a single-use
 * pairing invite, sealed to the browser, through the server's rendezvous box.
 */
export default function LinkWeb() {
  const params = useLocalSearchParams<{ k?: string; r?: string; t?: string; n?: string }>();
  const me = useMe();
  const { devices, refresh } = useSecurity();
  const initial = useMemo<Step>(() => {
    if (!params.k && !params.t) return { kind: 'scan' };
    try {
      return { kind: 'confirm', req: linkRequestFromParams(params) };
    } catch (e) {
      return { kind: 'error', message: message(e) };
    }
  }, [params]);
  const [step, setStep] = useState<Step>(initial);
  const before = useRef<number | null>(null);

  // After sending: the browser finishes the pairing and appears in the device list.
  useEffect(() => {
    if (step.kind !== 'sent') return;
    const t = setInterval(refresh, 2000);
    const giveUp = setTimeout(() => setStep({ kind: 'error', message: 'Le navigateur n’a pas terminé la liaison. Vérifie qu’il affiche toujours le QR code, puis réessaie.', req: step.req }), WAIT_MS);
    return () => {
      clearInterval(t);
      clearTimeout(giveUp);
    };
  }, [step, refresh]);
  useEffect(() => {
    if (step.kind !== 'sent' || before.current === null) return;
    const active = devices.filter((d) => !d.revoked);
    if (active.length > before.current) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setStep({ kind: 'done', req: step.req, name: active[active.length - 1]?.name ?? step.req.name ?? 'Navigateur' });
    }
  }, [devices, step]);

  const send = async (req: LinkWebRequest) => {
    setStep({ kind: 'sending', req });
    before.current = devices.filter((d) => !d.revoked).length;
    try {
      await sendLinkInvite(req, Device.deviceName ?? Device.modelName ?? undefined);
      setStep({ kind: 'sent', req });
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setStep({ kind: 'error', message: message(e), req });
    }
  };

  if (!me) {
    return (
      <View style={styles.sheet}>
        <SheetTitle title="Lier un navigateur" />
        <Empty icon="person-circle-outline" title="Aucun compte sur ce téléphone" text="Crée ou restaure ton compte avant de lier un navigateur." />
      </View>
    );
  }

  const browser = 'req' in step && step.req ? step.req.name || 'ce navigateur' : 'ce navigateur';

  return (
    <ScrollView style={styles.sheet} contentContainerStyle={{ paddingBottom: S.xxl }}>
      <SheetTitle title="Lier un navigateur" />
      <View style={{ paddingHorizontal: S.lg, gap: S.lg }}>
        {step.kind === 'scan' && <Scanner onScan={(data) => {
          try {
            setStep({ kind: 'confirm', req: parseLinkUrl(data) });
          } catch (e) {
            setStep({ kind: 'error', message: message(e) });
          }
        }} />}

        {(step.kind === 'confirm' || step.kind === 'sending') && (
          <>
            <View style={styles.card}>
              <Ionicons name="desktop-outline" size={40} color={C.accentText} />
              <Txt v="title" style={{ textAlign: 'center' }}>{`Lier ${browser} ?`}</Txt>
              <Txt v="body" style={{ textAlign: 'center' }}>
                {`Ce navigateur pourra publier en ton nom, lire tes messages et ta bibliothèque. Serveur : ${relayHost(step.req.relay)}.`}
              </Txt>
            </View>
            <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
              Ne scanne que le QR code affiché sur ton propre écran. Tu pourras révoquer ce navigateur à tout moment dans Réglages → Sécurité.
            </Txt>
            <Button label={`Lier ${browser}`} icon="link" loading={step.kind === 'sending'} disabled={step.kind === 'sending'} onPress={() => send(step.req)} />
            <Button variant="ghost" label="Annuler" onPress={() => router.back()} disabled={step.kind === 'sending'} />
          </>
        )}

        {step.kind === 'sent' && (
          <View style={styles.card}>
            <ActivityIndicator color={C.accentText} />
            <Txt v="headline" style={{ textAlign: 'center' }}>Invitation envoyée</Txt>
            <Txt v="body" style={{ textAlign: 'center' }}>{`Garde Huwa ouvert : ${browser} termine la liaison (quelques secondes).`}</Txt>
          </View>
        )}

        {step.kind === 'done' && (
          <>
            <View style={styles.card}>
              <Ionicons name="checkmark-circle" size={44} color={C.accentText} />
              <Txt v="title" style={{ textAlign: 'center' }}>{`${step.name} est lié`}</Txt>
              <Txt v="body" style={{ textAlign: 'center' }}>Il apparaît dans Réglages → Sécurité → Appareils liés.</Txt>
            </View>
            <Button label="Terminé" onPress={() => router.back()} />
          </>
        )}

        {step.kind === 'error' && (
          <>
            <View style={styles.card}>
              <Ionicons name="alert-circle-outline" size={40} color={DANGER} />
              <Txt v="body" color={DANGER} style={{ textAlign: 'center' }}>{step.message}</Txt>
            </View>
            {step.req ? <Button label="Réessayer" icon="refresh" onPress={() => send(step.req!)} /> : <Button label="Scanner à nouveau" icon="qr-code-outline" onPress={() => setStep({ kind: 'scan' })} />}
            <Button variant="ghost" label="Fermer" onPress={() => router.back()} />
          </>
        )}
      </View>
    </ScrollView>
  );
}

function Scanner({ onScan }: { onScan: (data: string) => void }) {
  const [permission, request] = useCameraPermissions();
  const handled = useRef(false);
  if (!permission) return <Loading />;
  if (!permission.granted)
    return (
      <Empty
        icon="camera-outline"
        title="Accès à la caméra"
        text="La caméra sert uniquement à lire le QR code affiché par Huwa Web. Rien n’est enregistré."
        action={
          permission.canAskAgain ? <Button label="Autoriser la caméra" icon="camera" onPress={request} /> : <Button label="Ouvrir les réglages" icon="settings-outline" onPress={() => Linking.openSettings()} />
        }
      />
    );
  return (
    <>
      <View style={styles.frame}>
        <CameraView
          style={StyleSheet.absoluteFill}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={({ data }) => {
            if (handled.current || !data.startsWith('huwa://link-web')) return;
            handled.current = true;
            Haptics.selectionAsync();
            onScan(data);
          }}
        />
        <View pointerEvents="none" style={styles.reticle} />
      </View>
      <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
        Sur l’ordinateur, ouvre Huwa Web et choisis « Lier avec mon téléphone », puis vise le QR code.
      </Txt>
    </>
  );
}

const styles = StyleSheet.create({
  sheet: { flex: 1, backgroundColor: C.surface },
  card: { alignItems: 'center', gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.elevated },
  frame: { aspectRatio: 1, borderRadius: R.sheet, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.black },
  reticle: {
    position: 'absolute', left: '18%', top: '18%', right: '18%', bottom: '18%',
    borderRadius: R.card, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)',
  },
});
