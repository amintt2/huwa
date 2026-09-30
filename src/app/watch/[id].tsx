import { useEventListener } from 'expo';
import { router, useLocalSearchParams, type Href } from 'expo-router';
import { useVideoPlayer, VideoView } from 'expo-video';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Linking, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { isPlayable, isTorrent, type AddonStream } from '@/addons/protocol';
import { detectQuality, rankStreams, streamKey } from '@/addons/quality';
import { useAddonPrefs, useAddons, useStreams } from '@/addons/registry';
import { resolveTorrent, useCachedHashes, useTorrentResolver } from '@/debrid/resolve';
import { EpisodeBridgeStrip } from '@/components/bridge';
import { CommentsPanel } from '@/components/comments';
import { Button, Chip, Cover, IconButton, Press, Txt } from '@/components/ui';
import { chapterAfterEpisode } from '@/data/bridge';
import { episodeLabel, getEpisode } from '@/data/catalog';
import { useThread } from '@/store/derived';
import { getState, markEpisodeDone, saveEpisodeProgress, toggleMyList, useStore } from '@/store/store';
import { C, S } from '@/theme/tokens';

export default function Watch() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const found = getEpisode(id);
  if (!found) return <Txt style={{ padding: S.xl }}>Épisode introuvable.</Txt>;
  return <WatchScreen key={id} id={id} />;
}

function WatchScreen({ id }: { id: string }) {
  const insets = useSafeAreaInsets();
  const { series, episode } = getEpisode(id)!;
  const eps = series.anime!.episodes;
  const next = eps.find((e) => e.number === episode.number + 1);
  const nextChapter = chapterAfterEpisode(series, episode);
  const inList = useStore((s) => s.myList.includes(series.id));
  const target = `ep:${id}`;
  const count = useThread(target).length;
  const lastSave = useRef(0);

  // ---- Stream selection: ranked list, debrid resolution for torrents, auto-fallback on error ----
  const { streams, pending, failed } = useStreams(series.id, episode.number);
  const prefs = useAddonPrefs();
  const addonList = useAddons();
  const resolverLabel = useTorrentResolver();
  const cached = useCachedHashes(streams.filter(isTorrent).map((s) => s.infoHash!));
  const ranked = useMemo(
    () => rankStreams(streams, {
      preferred: prefs.preferredQuality,
      addonOrder: addonList.map((a) => a.manifest.id),
      canResolveTorrents: !!resolverLabel,
      cached,
    }),
    [streams, prefs.preferredQuality, addonList, resolverLabel, cached],
  );
  const usable = (s: AddonStream) => isPlayable(s) || (isTorrent(s) && !!resolverLabel);
  const [picked, setPicked] = useState<string | undefined>();
  const [bad, setBad] = useState<string[]>([]);
  const [resolved, setResolved] = useState<Record<string, { url?: string; via?: string; error?: string }>>({});
  const current =
    (picked ? ranked.find((s) => streamKey(s) === picked) : undefined) ??
    ranked.find((s) => usable(s) && !bad.includes(streamKey(s)));
  const currentKey = current ? streamKey(current) : undefined;
  const currentRef = useRef(currentKey);
  useEffect(() => {
    currentRef.current = currentKey;
  }, [currentKey]);
  const sourceUrl = current ? (isPlayable(current) ? current.url : resolved[currentKey!]?.url) : undefined;
  const markBad = (k: string, error?: string) => {
    setBad((b) => (b.includes(k) ? b : [...b, k]));
    if (error) setResolved((r) => ({ ...r, [k]: { ...r[k], error } }));
    setPicked((p) => (p === k ? undefined : p));
  };

  // Torrent → HTTPS through the debrid service (or a registered native resolver).
  useEffect(() => {
    if (!current || !currentKey || !isTorrent(current) || !resolverLabel || resolved[currentKey]) return;
    const ctrl = new AbortController();
    resolveTorrent(
      { infoHash: current.infoHash!, fileIdx: current.fileIdx, filename: current.behaviorHints?.filename, sources: current.sources, episode: episode.number },
      ctrl.signal,
    )
      .then(({ url, via }) => setResolved((r) => ({ ...r, [currentKey]: { url, via } })))
      .catch((e) => {
        if (!ctrl.signal.aborted) markBad(currentKey, e instanceof Error ? e.message : 'Échec');
      });
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentKey, resolverLabel]);
  const resumed = useRef(false);

  const player = useVideoPlayer(null, (p) => {
    p.timeUpdateEventInterval = 1;
  });

  // Playback failure → next source in the ranked list.
  useEventListener(player, 'statusChange', ({ status, error }) => {
    if (status === 'error' && currentRef.current) markBad(currentRef.current, error?.message ?? 'Lecture impossible');
  });

  const headers = current?.behaviorHints?.proxyHeaders?.request;
  const headersKey = JSON.stringify(headers ?? {});
  useEffect(() => {
    if (!sourceUrl) return;
    resumed.current = false;
    player.replaceAsync({ uri: sourceUrl, headers }).then(() => {
      const saved = getState().episodes[id];
      if (!resumed.current && saved && !saved.done && saved.position > 5) player.currentTime = saved.position;
      resumed.current = true;
      player.play();
    }).catch(() => {
      if (currentRef.current) markBad(currentRef.current, 'Lecture impossible');
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceUrl, headersKey, player, id]);

  // Persist progress every 5 s and when leaving the screen.
  useEventListener(player, 'timeUpdate', ({ currentTime }) => {
    if (Date.now() - lastSave.current < 5000) return;
    lastSave.current = Date.now();
    saveEpisodeProgress(id, currentTime, player.duration);
  });
  useEventListener(player, 'playToEnd', () => markEpisodeDone(id));
  useEffect(() => () => {
    try {
      saveEpisodeProgress(id, player.currentTime, player.duration);
    } catch {
      // player already released
    }
  }, [id, player]);

  const header = (
    <View style={{ padding: S.lg, gap: S.lg }}>
      <View style={{ gap: 6 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm }}>
          <Chip kind="anime" />
          <Press onPress={() => router.push(`/anime/${series.id}`)}>
            <Txt v="small" style={{ fontSize: 13 }}>{series.title} · S1</Txt>
          </Press>
        </View>
        <Txt v="title">{episodeLabel(episode)}</Txt>
      </View>

      <View style={{ flexDirection: 'row', gap: S.sm, flexWrap: 'wrap' }}>
        <Button small variant="soft" icon={inList ? 'checkmark' : 'add'} label="Ma liste" onPress={() => toggleMyList(series.id)} />
        <Button small variant="soft" icon="chatbubble-outline" label={`${count}`}
          onPress={() => router.push({ pathname: '/comments', params: { target, kind: 'anime' } })} />
      </View>

      <View style={{ gap: S.sm }}>
        <Txt v="section">Sources</Txt>
        {ranked.map((st) => {
          const k = streamKey(st);
          const torrent = isTorrent(st);
          const ok = usable(st);
          const active = k === currentKey;
          const r = resolved[k];
          const failedHere = bad.includes(k);
          const q = detectQuality(st);
          const cachedHere = torrent ? cached[st.infoHash!.toLowerCase()] : undefined;
          const detail = failedHere
            ? ` · échec${r?.error ? ` : ${r.error}` : ''}`
            : torrent
              ? resolverLabel
                ? ` · torrent via ${resolverLabel}${cachedHere ? ' · en cache' : cachedHere === false ? ' · pas en cache' : ''}${active && !r?.url ? ' · résolution…' : ''}`
                : ' · torrent · configure un service débrid'
              : !ok && st.externalUrl
                ? ' · ouvre le navigateur'
                : '';
          return (
            <Press
              key={k}
              disabled={!ok && !st.externalUrl && !torrent}
              onPress={() => {
                if (ok) {
                  setBad((b) => b.filter((x) => x !== k));
                  setResolved((m) => (m[k]?.error ? { ...m, [k]: {} } : m));
                  setPicked(k);
                } else if (torrent) router.push('/debrid' as Href);
                else if (st.externalUrl) Linking.openURL(st.externalUrl);
              }}
              style={[styles.source, active && { backgroundColor: C.accentSoft }, (!ok || failedHere) && { opacity: 0.45 }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt v="label" numberOfLines={1}>{(st.name ?? 'Flux').replace(/\n/g, ' ') + (st.title ? ` · ${st.title.split('\n')[0]}` : '')}</Txt>
                <Txt v="small" numberOfLines={1}>{st.addonName}{detail}</Txt>
              </View>
              {q && <Chip kind="neutral" label={q === 2160 ? '4K' : `${q}p`} />}
              {active && <Chip kind="accent" label={r?.url || isPlayable(st) ? 'EN COURS' : '…'} />}
            </Press>
          );
        })}
        {!resolverLabel && streams.some(isTorrent) && (
          <Button small variant="soft" icon="flash-outline" label="Lire les torrents via un service débrid" onPress={() => router.push('/debrid' as Href)} />
        )}
        {pending > 0 && <Txt v="small">Recherche de sources… ({pending})</Txt>}
        {pending === 0 && streams.length === 0 && (
          <Txt v="small">Aucune source. Active ou installe un addon dans Profil → Addons.</Txt>
        )}
        {failed.length > 0 && <Txt v="small">Injoignable : {failed.join(', ')}</Txt>}
      </View>

      {next && (
        <Press onPress={() => router.replace(`/watch/${next.id}`)} style={styles.next} accessibilityLabel={`Suivant : ${episodeLabel(next)}`}>
          <Cover palette={series.palette} image={series.image} width={96} height={56} radius={10} />
          <View style={{ flex: 1, gap: 3 }}>
            <Txt v="caption" color={C.accentText}>À SUIVRE</Txt>
            <Txt v="label" numberOfLines={1}>{episodeLabel(next)}</Txt>
          </View>
          <View style={styles.nextPlay}>
            <IconButton icon="play" label="Lire" size={40} tone="solid" color={C.white} onPress={() => router.replace(`/watch/${next.id}`)} />
          </View>
        </Press>
      )}

      {series.manhwa && (
        <EpisodeBridgeStrip from={episode.chapters[0]} to={episode.chapters[1]} nextChapterId={nextChapter?.id} estimated={series.estimated} />
      )}

      <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: S.sm }}>
        <Txt v="section">Commentaires</Txt>
        <Txt v="small" style={{ fontSize: 14 }}>{count}</Txt>
      </View>
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: C.bg }}>
      <View style={{ paddingTop: insets.top, backgroundColor: C.black }}>
        <View style={styles.topBar}>
          <IconButton icon="chevron-back" label="Retour" onPress={() => router.back()} />
          <Txt v="small" numberOfLines={1} style={{ flex: 1 }}>{series.title}</Txt>
        </View>
        <VideoView
          player={player}
          style={styles.video}
          nativeControls
          allowsPictureInPicture
          contentFit="contain"
        />
      </View>
      <CommentsPanel
        target={target}
        kind="anime"
        header={header}
        getTime={() => player.currentTime}
        onSeek={(t) => {
          player.seekBy(t - player.currentTime);
          player.play();
        }}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  topBar: { flexDirection: 'row', alignItems: 'center', gap: S.md, paddingHorizontal: S.md, paddingBottom: S.sm },
  video: { width: '100%', aspectRatio: 16 / 9, backgroundColor: C.black },
  source: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: S.md, borderRadius: 14, backgroundColor: C.surface },
  next: { flexDirection: 'row', alignItems: 'center', gap: S.md, padding: 10, borderRadius: 16, backgroundColor: C.surface },
  nextPlay: { borderRadius: 20, overflow: 'hidden', backgroundColor: C.accent },
});
