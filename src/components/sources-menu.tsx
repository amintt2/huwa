import { Ionicons } from '@expo/vector-icons';
import { router, type Href } from 'expo-router';
import { useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';

import { detectLangs } from '@/addons/audio';
import { verifiedAudio } from '@/addons/track-info';
import { isTorrent, type AddonStream } from '@/addons/protocol';
import { detectQuality, QUALITIES, streamKey, type Quality } from '@/addons/quality';
import { qualityLabel, type useSource } from '@/addons/use-source';
import { enableTorrentEngine, isAvailable as torrentEngineAvailable } from '@/torrent';
import { hostOf } from '@/addons/web-player';
import { AddonInfos } from '@/components/addon-infos';
import { EngineBadge } from '@/components/player/engines';
import { Sheet, SheetLabel } from '@/components/sheet';
import { Button, Chip, InfoPill, Press, Txt } from '@/components/ui';
import { YouTubePlayer } from '@/components/youtube-player';
import { langName } from '@/subtitles/lang';
import { C, R, S, SHADOW } from '@/theme/tokens';

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
      <View style={styles.buttonIcon}>
        <Ionicons name="layers-outline" size={18} color={C.accentText} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
          <Txt v="label" numberOfLines={1} style={{ flexShrink: 1 }}>{status}</Txt>
          <EngineBadge />
        </View>
        <Txt v="footnote" numberOfLines={1} tabular>
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

/** Sheet under the player (portrait) with the source list. */
export function SourcesMenu({ src, visible, onClose }: { src: Source; visible: boolean; onClose: () => void }) {
  const { ranked, pending } = src;
  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title="Sources"
      subtitle={`${ranked.length} source${ranked.length > 1 ? 's' : ''}${pending > 0 ? ` · ${pending} addon${pending > 1 ? 's' : ''} en attente` : ''}`}
      detents={['medium', 'large']}>
      <SourcesList src={src} onDone={onClose} />
    </Sheet>
  );
}

/**
 * "Automatique" + every source by quality, with the torrent / debrid fixes. Shown in the sheet
 * above and in the player settings ("Qualité et source"). `onDone`: a source was chosen.
 */
export function SourcesList({ src, onDone }: { src: Source; onDone: () => void }) {
  const { ranked, auto, pending, failed, resolverLabel, currentKey } = src;
  const onClose = onDone;
  const [yt, setYt] = useState<{ id: string; title?: string } | null>(null);

  const engineOff = !resolverLabel && torrentEngineAvailable();
  const choose = async (s: AddonStream) => {
    const st = src.stateOf(s);
    if (st === 'needs-debrid') {
      if (engineOff) {
        // The engine registers itself synchronously as a resolver once enabled.
        if (await enableTorrentEngine()) {
          src.pick(s);
          onClose();
        }
        return;
      }
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
    <>
      <EngineBadge variant="row" />
      <Press onPress={() => { src.pick('auto'); onClose(); }} scaleTo={0.98} style={[styles.row, auto && styles.active]}
        accessibilityRole="button" accessibilityState={{ selected: auto }} accessibilityLabel="Automatique">
        <View style={[styles.autoIcon, auto && { backgroundColor: C.accent }]}>
          <Ionicons name="sparkles" size={16} color={C.white} />
        </View>
        <View style={{ flex: 1, gap: 3 }}>
          <Txt v="label" color={auto ? C.accentText : C.text}>Automatique</Txt>
          <Txt v="footnote">
            Le lien le plus rapide dans ta langue. Une meilleure qualité prend le relais sans couper la lecture quand le réseau suit.
          </Txt>
          {src.raceStats.enabled ? (
            src.raceStats.measured > 0 && (
              <Txt v="footnote" color={C.text3} tabular>
                {src.raceStats.measured} lien{src.raceStats.measured > 1 ? 's' : ''} testé{src.raceStats.measured > 1 ? 's' : ''}
                {src.raceStats.dead > 0 ? ` · ${src.raceStats.dead} hors ligne écarté${src.raceStats.dead > 1 ? 's' : ''}` : ''}
              </Txt>
            )
          ) : (
            <Txt v="footnote" color={C.text3}>Test de vitesse désactivé sur ce réseau (données mobiles limitées ou hors ligne).</Txt>
          )}
        </View>
        {auto && <Ionicons name="checkmark" size={20} color={C.accentText} />}
      </Press>

      {GROUPS.map((g) => {
        const items = ranked.filter((s) => g.match(detectQuality(s)));
        if (!items.length) return null;
        return (
          <View key={g.label} style={{ gap: S.sm }}>
            <SheetLabel>{`${g.label} · ${items.length}`}</SheetLabel>
            {items.map((s) => <SourceRow key={streamKey(s)} s={s} src={src} active={streamKey(s) === currentKey} onPress={() => choose(s)} />)}
          </View>
        );
      })}

      {pending > 0 && <Txt v="small">Recherche en cours… ({pending} addon{pending > 1 ? 's' : ''})</Txt>}
      {pending === 0 && ranked.length === 0 && <Txt v="small">Aucune source. Active ou installe un addon dans Profil → Extensions.</Txt>}
      {failed.length > 0 && <Txt v="small">Injoignable : {failed.join(', ')}</Txt>}
      <AddonInfos infos={src.infos} />
      {!resolverLabel && ranked.some(isTorrent) && (
        <View style={{ gap: S.sm }}>
          {engineOff && (
            <Button small icon="flash-outline" label="Lire les torrents avec le moteur intégré"
              onPress={() => { enableTorrentEngine().catch(() => {}); }} />
          )}
          <Button small variant="soft" icon="cloud-outline" label={engineOff ? 'Ou via un service débrid (plus rapide)' : 'Lire les torrents via un service débrid'}
            onPress={() => { onClose(); router.push('/debrid' as Href); }} />
        </View>
      )}
      <YouTubePlayer ytId={yt?.id ?? null} title={yt?.title} onClose={() => setYt(null)} />
    </>
  );
}

function SourceRow({ s, src, active, onPress }: { s: AddonStream; src: Source; active: boolean; onPress: () => void }) {
  const st = src.stateOf(s);
  const torrent = isTorrent(s);
  const audio = verifiedAudio(src.trackKeysOf(s));
  const cached = src.cachedOf(s);
  const web = src.webOf(s);
  const detail = [
    s.addonName,
    web && hostOf(web),
    torrent && (src.resolverLabel ? `torrent via ${src.resolverLabel}` : torrentEngineAvailable() ? 'torrent · touche pour activer le moteur intégré' : 'torrent · service débrid requis'),
    cached === true && 'en cache',
    cached === false && 'pas en cache',
    st === 'youtube' && 'YouTube',
    st === 'external' && 'ouvre le navigateur',
    st === 'failed' && `échec${src.errorOf(s) ? ` : ${src.errorOf(s)}` : ''}`,
    // The file's real audio tracks, once read (header sniff, the player).
    audio?.langs.length && `audio : ${audio.langs.map((l) => langName(l).toLowerCase()).join(', ')}`,
  ].filter(Boolean).join(' · ');
  const speed = src.speedInfo(s);
  const dim = st === 'failed' || st === 'unusable' || speed?.speed === 'dead' || (st === 'needs-debrid' && !torrentEngineAvailable());
  const langLabel = detectLangs(s).label;
  return (
    <Press onPress={onPress} disabled={st === 'unusable'} scaleTo={0.98} style={[styles.row, active && styles.active, dim && { opacity: 0.5 }]}
      accessibilityRole="button" accessibilityState={{ selected: active, disabled: st === 'unusable' }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Txt v="label" numberOfLines={1} color={active ? C.accentText : C.text}>{(s.name ?? 'Flux').replace(/\n/g, ' ') + (s.title ? ` · ${s.title.split('\n')[0]}` : '')}</Txt>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          {!!web && <InfoPill icon="globe-outline" label="Lecteur web" />}
          <Txt v="footnote" numberOfLines={2} style={{ flexShrink: 1 }}>{detail}</Txt>
        </View>
        {speed && (
          <View style={{ flexDirection: 'row' }}>
            <InfoPill
              icon={speed.speed === 'fast' ? 'flash' : speed.speed === 'dead' ? 'cloud-offline-outline' : speed.speed === 'slow' ? 'hourglass-outline' : speed.speed ? 'speedometer-outline' : 'pulse-outline'}
              label={speed.label}
              tone={speed.speed === 'fast' ? 'accent' : 'neutral'}
            />
          </View>
        )}
      </View>
      {!!langLabel && <Chip kind="neutral" label={langLabel} />}
      {active && <Chip kind="accent" label={st === 'playing' ? 'En cours' : '…'} />}
    </Press>
  );
}

const styles = StyleSheet.create({
  button: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, minHeight: 60, borderRadius: R.card, borderCurve: 'continuous',
    backgroundColor: C.surface, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset,
  },
  buttonIcon: { width: 36, height: 36, borderRadius: 10, borderCurve: 'continuous', alignItems: 'center', justifyContent: 'center', backgroundColor: C.accentSoft },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 14, borderRadius: R.control, borderCurve: 'continuous',
    backgroundColor: C.elevated, borderWidth: 1, borderColor: 'rgba(255,255,255,0.05)',
  },
  active: { backgroundColor: C.accentSoft, borderColor: C.accentLine },
  autoIcon: { width: 32, height: 32, borderRadius: 16, alignSelf: 'flex-start', alignItems: 'center', justifyContent: 'center', backgroundColor: C.surface },
});
