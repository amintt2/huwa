import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Linking, Modal, ScrollView, StyleSheet, View } from 'react-native';

import { detectLangs } from '@/addons/audio';
import { isTorrent, type AddonStream } from '@/addons/protocol';
import { detectQuality, QUALITIES, streamKey, type Quality } from '@/addons/quality';
import { qualityLabel, type useSource } from '@/addons/use-source';
import { hostOf } from '@/addons/web-player';
import { EngineBadge } from '@/components/player/engines';
import { Button, Chip, IconButton, InfoPill, Press, Txt } from '@/components/ui';
import { YouTubePlayer } from '@/components/youtube-player';
import { C, R, S } from '@/theme/tokens';

type Source = ReturnType<typeof useSource>;

/** Compact row under the player: current source + opens the menu. */
export function SourceButton({ src, onOpen }: { src: Source; onOpen: () => void }) {
  const { current, quality, auto, pending, ranked } = src;
  const status = !current
    ? pending > 0 ? 'Recherche de sources…' : ranked.length ? 'Aucune source lisible' : 'Aucune source'
    : src.web ? `${qualityLabel(quality)} · Lecteur web · ${src.web.host}`
    : src.url ? `${qualityLabel(quality)} · ${current.addonName}` : `Préparation · ${current.addonName}`;
  return (
    <Press onPress={onOpen} style={styles.button} accessibilityRole="button" accessibilityLabel={`Sources : ${status}`}>
      <Ionicons name="layers-outline" size={20} color={C.accentText} />
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>{status}</Txt>
          <EngineBadge />
        </View>
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
  const [yt, setYt] = useState<{ id: string; title?: string } | null>(null);

  const choose = (s: AddonStream) => {
    const st = src.stateOf(s);
    if (st === 'needs-debrid') {
      onClose();
      router.push('/debrid' as Href);
    } else if (st === 'youtube') setYt({ id: s.ytId!, title: s.title ?? s.name });
    else if (st === 'external') Linking.openURL(s.externalUrl!).catch(() => {});
    else if (st !== 'unusable') {
      src.pick(s);
      onClose();
    }
  };

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}
      supportedOrientations={['portrait', 'landscape-left', 'landscape-right']}>
      <View style={{ flex: 1, backgroundColor: C.surface }}>
        <View style={styles.header}>
          <Txt v="section" style={{ flex: 1 }}>Sources</Txt>
          <IconButton icon="close" label="Fermer" onPress={onClose} />
        </View>
        <ScrollView contentContainerStyle={{ padding: S.lg, gap: S.lg, paddingBottom: S.xxl }}>
          <EngineBadge variant="row" />
          <Press onPress={() => { src.pick('auto'); onClose(); }} style={[styles.row, auto && styles.active]}>
            <Ionicons name="sparkles-outline" size={20} color={C.accentText} />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt v="label">Automatique</Txt>
              <Txt v="small">Lance la première source qui marche, puis passe à une meilleure qualité dès qu’elle est trouvée. Les lecteurs web ne servent que s’il n’y a pas de lien direct.</Txt>
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
          {pending === 0 && ranked.length === 0 && <Txt v="small">Aucune source. Active ou installe un addon dans Profil → Extensions.</Txt>}
          {failed.length > 0 && <Txt v="small">Injoignable : {failed.join(', ')}</Txt>}
          {!resolverLabel && ranked.some(isTorrent) && (
            <Button small variant="soft" icon="flash-outline" label="Lire les torrents via un service débrid"
              onPress={() => { onClose(); router.push('/debrid' as Href); }} />
          )}
        </ScrollView>
      </View>
      <YouTubePlayer ytId={yt?.id ?? null} title={yt?.title} onClose={() => setYt(null)} />
    </Modal>
  );
}

function SourceRow({ s, src, active, onPress }: { s: AddonStream; src: Source; active: boolean; onPress: () => void }) {
  const st = src.stateOf(s);
  const torrent = isTorrent(s);
  const cached = src.cachedOf(s);
  const web = src.webOf(s);
  const detail = [
    s.addonName,
    web && hostOf(web),
    torrent && (src.resolverLabel ? `torrent via ${src.resolverLabel}` : 'torrent · service débrid requis'),
    cached === true && 'en cache',
    cached === false && 'pas en cache',
    st === 'youtube' && 'YouTube',
    st === 'external' && 'ouvre le navigateur',
    st === 'failed' && `échec${src.errorOf(s) ? ` : ${src.errorOf(s)}` : ''}`,
  ].filter(Boolean).join(' · ');
  const dim = st === 'failed' || st === 'unusable' || st === 'needs-debrid';
  const langLabel = detectLangs(s).label;
  return (
    <Press onPress={onPress} disabled={st === 'unusable'} style={[styles.row, active && styles.active, dim && { opacity: 0.5 }]}>
      <View style={{ flex: 1, gap: 2 }}>
        <Txt v="label" numberOfLines={1}>{(s.name ?? 'Flux').replace(/\n/g, ' ') + (s.title ? ` · ${s.title.split('\n')[0]}` : '')}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          {!!web && <InfoPill icon="globe-outline" label="Lecteur web" />}
          <Txt v="small" numberOfLines={2} style={{ flexShrink: 1 }}>{detail}</Txt>
        </View>
      </View>
      {!!langLabel && <Chip kind="neutral" label={langLabel} />}
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
