import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import { useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Empty, Loading, ScreenHeader } from '@/components/social';
import { Button, Txt } from '@/components/ui';
import { social } from '@/p2p/hooks';
import { C, R, S } from '@/theme/tokens';

/** New device: scan the pairing QR shown by an already signed-in device. */
export default function ScanPairing() {
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const handled = useRef(false);

  const onScan = async (data: string) => {
    if (handled.current) return;
    handled.current = true;
    setBusy(true);
    Haptics.selectionAsync();
    try {
      await social.acceptPairing(data);
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (e) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(e instanceof Error ? e.message : 'Appairage impossible.');
      setBusy(false);
    }
  };

  const retry = () => {
    setError(undefined);
    handled.current = false;
  };

  let body;
  if (!permission) body = <Loading />;
  else if (!permission.granted)
    body = (
      <Empty
        icon="camera-outline"
        title="Accès à la caméra"
        text="La caméra sert uniquement à lire le QR code affiché sur ton autre appareil. Rien n’est enregistré."
        action={
          permission.canAskAgain ? (
            <Button label="Autoriser la caméra" icon="camera" onPress={request} />
          ) : (
            <Button label="Ouvrir les réglages" icon="settings-outline" onPress={() => Linking.openSettings()} />
          )
        }
      />
    );
  else
    body = (
      <View style={{ gap: S.lg, paddingHorizontal: S.lg }}>
        <View style={styles.frame}>
          <CameraView
            style={StyleSheet.absoluteFill}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
            onBarcodeScanned={error || busy ? undefined : ({ data }) => onScan(data)}
          />
          <View pointerEvents="none" style={styles.reticle} />
        </View>
        {error ? (
          <View style={{ gap: S.md }}>
            <Txt v="body" color="#FF6B6B">{error}</Txt>
            <Button variant="ghost" label="Scanner à nouveau" icon="refresh" onPress={retry} />
            <Button variant="soft" label="Utiliser ma phrase" icon="key-outline" onPress={() => router.back()} />
          </View>
        ) : (
          <Txt v="small" style={{ textAlign: 'center', lineHeight: 18 }}>
            {busy ? 'Connexion à ton autre appareil…' : 'Vise le QR code affiché dans Réglages → Sécurité → Lier un appareil.'}
          </Txt>
        )}
      </View>
    );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg, paddingBottom: insets.bottom }}>
      <ScreenHeader title="Scanner le QR code" />
      {body}
    </View>
  );
}

const styles = StyleSheet.create({
  frame: { aspectRatio: 1, borderRadius: R.sheet, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.black },
  reticle: {
    position: 'absolute', left: '18%', top: '18%', right: '18%', bottom: '18%',
    borderRadius: R.card, borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)',
  },
});
