import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Alert, ScrollView, StyleSheet, View } from 'react-native';
import QRCode from 'react-native-qrcode-svg';

import { SheetTitle } from '@/components/screen';
import { DANGER, Loading } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { C, S, SHADOW } from '@/theme/tokens';

const TTL = 10 * 60;

/** Existing device: shows a short-lived pairing invite as a QR code. */
export default function Pair() {
  const [invite, setInvite] = useState<string>();
  const [left, setLeft] = useState(TTL);
  const [error, setError] = useState<string>();

  const renew = useCallback(() => {
    setError(undefined);
    setInvite(undefined);
    social
      .pairingInvite()
      .then((i) => {
        setInvite(i);
        setLeft(TTL);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    let alive = true;
    social
      .pairingInvite()
      .then((i) => alive && setInvite(i))
      .catch((e) => alive && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      alive = false;
    };
  }, []);
  useEffect(() => {
    const t = setInterval(() => setLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(t);
  }, []);

  const expired = left === 0;
  const mm = `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;

  return (
    // Form sheet: the header lives inside the ScrollView (a sibling above it is drawn under it).
    <ScrollView style={{ flex: 1, backgroundColor: C.surface }} contentContainerStyle={{ paddingBottom: S.xxl }}>
      <SheetTitle title="Lier un appareil" />
      <View style={{ paddingHorizontal: S.lg, paddingTop: S.sm, gap: S.lg, alignItems: 'center' }}>
        <Txt v="body" style={{ textAlign: 'center', maxWidth: 340 }}>
          Sur le nouvel appareil, ouvre Huwa, touche « J’ai déjà un compte », puis « Scanner depuis mon autre appareil ».
        </Txt>
        <View style={styles.qr} accessible accessibilityLabel="QR code d’appairage">
          {error ? (
            <Txt v="small" color={DANGER} style={{ textAlign: 'center' }}>{error}</Txt>
          ) : !invite ? (
            <Loading />
          ) : (
            <View style={{ opacity: expired ? 0.15 : 1 }}>
              <QRCode value={invite} size={232} color="#05070D" backgroundColor="#FFFFFF" ecl="M" quietZone={12} />
            </View>
          )}
        </View>
        <Txt v="small" style={{ textAlign: 'center', fontVariant: ['tabular-nums'] }}>
          {expired ? 'QR code expiré.' : `Valable encore ${mm} · usage unique`}
        </Txt>
        {expired && <Button label="Générer un nouveau code" icon="refresh" onPress={renew} />}
        <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
          Ne montre ce code qu’à tes propres appareils : il permet de publier en ton nom. Tu pourras révoquer l’appareil à tout moment.
        </Txt>
        {__DEV__ && invite && !expired && (
          <Button
            variant="ghost"
            small
            label="Test : appairer ici (boucle locale)"
            onPress={() =>
              social
                .acceptPairing(invite)
                .then(() => {
                  Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
                  router.back();
                })
                .catch((e) => Alert.alert('Appairage', e instanceof Error ? e.message : String(e)))
            }
          />
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  qr: {
    width: 264, height: 264, alignItems: 'center', justifyContent: 'center', borderRadius: 20,
    borderCurve: 'continuous', backgroundColor: C.white, overflow: 'hidden', boxShadow: SHADOW.float,
  },
});
