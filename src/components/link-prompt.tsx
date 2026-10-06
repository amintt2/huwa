// Introduction (full flavor): "Tu as un pack ou un lien ?" — paste or scan a pack link, a site
// pack link, a huwa:// link, a Stremio manifest or a Paperback repository. The link is kept and
// opened on its confirmation screen once the introduction is over (nothing installs from here).
import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import * as Haptics from 'expo-haptics';
import { useRef, useState } from 'react';
import { Linking, Modal, StyleSheet, TextInput, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useT } from '@/i18n';
import { classifyLink, decodePack, type PastedLink } from '@/packs/format';
import { hrefFor, setPendingLink, usePendingLink } from '@/packs/routes';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { SheetTitle } from './screen';
import { Button, IconButton, Txt } from './ui';

export function LinkPrompt() {
  const t = useT();
  const pending = usePendingLink();
  const [text, setText] = useState('');
  const [state, setState] = useState<{ ok?: string; error?: string }>({});
  const [scanning, setScanning] = useState(false);

  const submit = (raw = text) => {
    const link = classifyLink(raw);
    if (!link) return setState({ error: t('onb.link.invalid') });
    let ok = t('onb.link.ready');
    if (link.kind === 'pack' && 'd' in link.ref) {
      try {
        const pack = decodePack(link.ref.d);
        ok = t('onb.link.pack', { name: pack.name, count: pack.video.length + pack.manga.length });
      } catch (e) {
        return setState({ error: e instanceof Error ? e.message : t('onb.link.invalid') });
      }
    }
    setPendingLink(hrefFor(link));
    setText('');
    setState({ ok });
  };

  return (
    <View style={styles.box}>
      <Txt v="label">{t('onb.link.title')}</Txt>
      <View style={{ flexDirection: 'row', gap: S.sm }}>
        <TextInput
          value={text}
          onChangeText={(v) => {
            setText(v);
            if (state.error) setState({});
          }}
          onSubmitEditing={() => submit()}
          placeholder={t('onb.link.placeholder')}
          placeholderTextColor={C.text2}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          returnKeyType="go"
          keyboardAppearance="dark"
          accessibilityLabel={t('onb.link.title')}
          style={styles.input}
        />
        <IconButton icon="qr-code-outline" label={t('onb.link.scan')} tone="solid" size={44} onPress={() => setScanning(true)} />
      </View>
      {!!text.trim() && <Button small variant="soft" label={t('onb.link.open')} onPress={() => submit()} />}
      {state.error ? <Txt v="small" color={C.danger}>{state.error}</Txt> : null}
      {pending && state.ok ? (
        <View style={{ flexDirection: 'row', gap: S.sm, alignItems: 'flex-start' }}>
          <Ionicons name="checkmark-circle" size={16} color={C.success} style={{ marginTop: 1 }} />
          <Txt v="small" style={{ flex: 1, color: C.body }}>{state.ok}</Txt>
        </View>
      ) : null}
      <Scanner
        visible={scanning}
        onClose={() => setScanning(false)}
        onLink={(raw) => {
          setScanning(false);
          submit(raw);
        }}
      />
    </View>
  );
}

export function Scanner({ visible, onClose, onLink }: { visible: boolean; onClose: () => void; onLink: (raw: string, link: PastedLink) => void }) {
  const t = useT();
  const insets = useSafeAreaInsets();
  const [permission, request] = useCameraPermissions();
  const [error, setError] = useState('');
  const handled = useRef('');

  const onScan = (data: string) => {
    if (handled.current === data) return;
    handled.current = data;
    const link = classifyLink(data);
    if (!link) {
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      setError(t('onb.link.invalid'));
      return;
    }
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setError('');
    handled.current = '';
    onLink(data, link);
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.bg, padding: S.lg, gap: S.lg, paddingBottom: insets.bottom + S.lg }}>
        <View style={{ marginHorizontal: -S.lg, marginTop: -S.lg }}>
          <SheetTitle title={t('onb.link.scan')} onClose={onClose} />
        </View>
        {!permission ? null : !permission.granted ? (
          <View style={{ gap: S.md, paddingTop: S.xl }}>
            <Txt v="body">{t('onb.link.cameraWhy')}</Txt>
            {permission.canAskAgain ? (
              <Button label={t('onb.link.cameraAllow')} icon="camera" onPress={request} />
            ) : (
              <Button label={t('onb.link.cameraSettings')} icon="settings-outline" onPress={() => Linking.openSettings()} />
            )}
          </View>
        ) : (
          <>
            <View style={styles.frame}>
              {visible && (
                <CameraView
                  style={StyleSheet.absoluteFill}
                  facing="back"
                  barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                  onBarcodeScanned={({ data }) => onScan(data)}
                />
              )}
              <View pointerEvents="none" style={styles.reticle} />
            </View>
            <Txt v="small" style={{ textAlign: 'center' }} color={error ? C.danger : C.text2}>{error || t('onb.link.scanHint')}</Txt>
          </>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  box: { gap: S.sm, padding: S.md, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset },
  input: {
    flex: 1, minHeight: 44, paddingHorizontal: S.md, borderRadius: R.control, borderCurve: 'continuous', backgroundColor: C.elevated,
    color: C.text, ...F.medium, fontSize: 15, borderWidth: 1, borderColor: C.border, boxShadow: 'inset 0px 1px 2px rgba(0,0,0,0.35)',
  },
  frame: { aspectRatio: 1, borderRadius: R.sheet, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: C.black },
  reticle: {
    position: 'absolute', left: '18%', top: '18%', right: '18%', bottom: '18%',
    borderRadius: R.card, borderCurve: 'continuous', borderWidth: 2, borderColor: 'rgba(255,255,255,0.8)', boxShadow: '0px 0px 0px 2000px rgba(0,0,0,0.35)',
  },
});
