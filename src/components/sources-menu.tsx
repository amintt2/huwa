import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { Linking, Modal, ScrollView, StyleSheet, View } from 'react-native';

import { isTorrent, type AddonStream } from '@/addons/protocol';
import { detectQuality, QUALITIES, streamKey, type Quality } from '@/addons/quality';
import { qualityLabel, type useSource } from '@/addons/use-source';
import { Button, Chip, IconButton, Press, Txt } from '@/components/ui';
import { C, R, S } from '@/theme/tokens';

type Source = ReturnType<typeof useSource>;

/** Compact row under the player: current source + opens the menu. */
export function SourceButton({ src, onOpen }: { src: Source; onOpen: () => void }) {
  const { current, quality, auto, pending, ranked } = src;
  const status = !current
    ? pending > 0 ? 'Recherche de sources…' : ranked.length ? 'Aucune source lisible' : 'Aucune source'
    : src.url ? `${qualityLabel(quality)} · ${current.addonName}` : `Préparation · ${current.addonName}`;
  return (
    <Press onPress={onOpen} style={styles.button} accessibilityRole="button" accessibilityLabel={`Sources : ${status}`}>
      <Ionicons name="layers-outline" size={20} color={C.accentText} />
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1}>{status}</Txt>
        <Txt v="small" numberOfLines={1}>
          {auto ? 'Automatique' : 'Choix manuel'} · {ranked.length} source{ranked.length > 1 ? 's' : ''}
          {pending > 0 ? ` · ${pending} addon${pending > 1 ? 's' : ''} en attente` : ''}
        </Txt>
      </View>
      <Ionicons name="chevron-forward" size={18} color={C.text2} />
    </Press>
  );
}

const GROUPS: { label: string; match: (q: Quality | null) => boolean }[] = [
  ...QUALITIES.map((q) => ({ label: qualityLabel(q), match: (x: Quality | null) => x === q })),
  { label: 'Qualité inconnue', match: (x) => x == null },
];

export function SourcesMenu({ src, visible, onClose }: { src: Source; visible: boolean; onClose: () => void }) {
  const { ranked, auto, pending, failed, resolverLabel, currentKey } = src;

  const choose = (s: AddonStream) => {
    const st = src.stateOf(s);
    if (st === 'needs-debrid') {
      onClose();
      router.push('/debrid' as Href);
    } else if (st === 'external') Linking.openURL(s.externalUrl!);
    else if (st !== 'unusable') {
      src.pick(s);
      onClose();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View style={{ flex: 1, backgroundColor: C.surface }}>
        <View style={styles.header}>
          <Txt v="section" style={{ flex: 1 }}>Sources</Txt>
          <IconButton icon="close" label="Fermer" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.lg, paddingBottom: S.xxl }}>
          <Press onPress={() => { src.pick('auto'); onClose(); }} style={[styles.row, auto && styles.active]}>
            <Ionicons name="sparkles-outline" size={20} color={C.accentText} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label">Automatique</Txt>
              <Txt v="small">Lance la première source qui marche, puis passe à une meilleure qualité dès qu’elle est trouvée.</Txt>
            </View>
            {auto && <Ionicons name="checkmark" size={20} color={C.accentText} />}
          </Press>

          {GROUPS.map((g) => {
            const items = ranked.filter((s) => g.match(detectQuality(s)));
            if (!items.length) return null;
            return (
              <View key={g.label} style={{ gap: S.sm }}>
                <Txt v="caption" color={C.text2}>{g.label.toUpperCase()} · {items.length}</Txt>
                {items.map((s) => <SourceRow key={streamKey(s)} s={s} src={src} active={streamKey(s) === currentKey} onPress={() => choose(s)} />)}
              </View>
            );
          })}

          {pending > 0 && <Txt v="small">Recherche en cours… ({pending} addon{pending > 1 ? 's' : ''})</Txt>}
          {pending === 0 && ranked.length === 0 && <Txt v="small">Aucune source. Active ou installe un addon dans Profil → Addons.</Txt>}
          {failed.length > 0 && <Txt v="small">Injoignable : {failed.join(', ')}</Txt>}
          {!resolverLabel && ranked.some(isTorrent) && (
            <Button small variant="soft" icon="flash-outline" label="Lire les torrents via un service débrid"
              onPress={() => { onClose(); router.push('/debrid' as Href); }} />
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function SourceRow({ s, src, active, onPress }: { s: AddonStream; src: Source; active: boolean; onPress: () => void }) {
  const st = src.stateOf(s);
  const torrent = isTorrent(s);
  const cached = src.cachedOf(s);
  const detail = [
    s.addonName,
    torrent && (src.resolverLabel ? `torrent via ${src.resolverLabel}` : 'torrent · service débrid requis'),
    cached === true && 'en cache',
    cached === false && 'pas en cache',
    st === 'external' && 'ouvre le navigateur',
    st === 'failed' && `échec${src.errorOf(s) ? ` : ${src.errorOf(s)}` : ''}`,
  ].filter(Boolean).join(' · ');
  const dim = st === 'failed' || st === 'unusable' || st === 'needs-debrid';
  return (
    <Press onPress={onPress} disabled={st === 'unusable'} style={[styles.row, active && styles.active, dim && { opacity: 0.5 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1}>{(s.name ?? 'Flux').replace(/\n/g, ' ') + (s.title ? ` · ${s.title.split('\n')[0]}` : '')}</Txt>
        <Txt v="small" numberOfLines={2}>{detail}</Txt>
      </View>
      {active && <Chip kind="accent" label={st === 'playing' ? 'EN COURS' : '…'} />}
    </Press>
  );
}

const styles = StyleSheet.create({
  button: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.surface },
  header: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: S.lg, paddingTop: S.lg, paddingBottom: S.sm },
  row: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: R.card, backgroundColor: C.elevated },
  active: { backgroundColor: C.accentSoft, borderWidth: 1, borderColor: C.accentLine },
});
