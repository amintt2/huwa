// Watch screen side of the start timings (src/addons/timing.ts): screen / sources / choice marks,
// how the URL was obtained (path), resume vs fresh start, network type, "no source" failures,
// and the end of the start when the screen closes. One hook call in app/watch/[id].tsx.
import { NetworkStateType, useNetworkState } from 'expo-network';
import { useEffect } from 'react';

import { isTorrent, type AddonStream } from '@/addons/protocol';
import { traceEnd, traceFail, traceInfo, traceMark } from '@/addons/timing';
import { getState } from '@/store/store';

import { classifyPath, type NetKind } from './model';
import { scheduleShare } from './share';

type SourceView = {
  ranked: AddonStream[];
  current?: AddonStream;
  currentKey?: string;
  url?: string;
  web: { url: string } | null;
  noSource: unknown;
};

export function useWatchTrace(id: string, src: SourceView) {
  const net = useNetworkState();
  const network: NetKind | undefined =
    net.type === NetworkStateType.WIFI || net.type === NetworkStateType.ETHERNET ? 'wifi'
      : net.type === NetworkStateType.CELLULAR ? 'cellular'
        : net.type == null || net.type === NetworkStateType.UNKNOWN ? undefined : 'other';

  useEffect(() => {
    traceMark(id, 'screen');
    const saved = getState().episodes[id];
    if (saved && !saved.done && saved.position > 1) traceInfo(id, { kind: 'resume' });
    return () => {
      traceEnd(id);
      scheduleShare();
    };
  }, [id]);

  const hasSources = src.ranked.length > 0;
  const fromDisk = src.ranked.some((s) => s.cachedAt != null);
  useEffect(() => {
    if (hasSources) traceMark(id, 'sources', fromDisk ? 'cache disque' : undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasSources, id]);
  useEffect(() => {
    if (src.currentKey) traceMark(id, 'decision');
  }, [src.currentKey, id]);

  // Path of what plays (the URL is classified here and never stored).
  const torrent = !!src.current && isTorrent(src.current);
  const path = classifyPath({ web: !!src.web, torrent, url: src.url });
  useEffect(() => {
    if (path) traceInfo(id, { path });
    // The hosted player page is "the URL" of a web start.
    if (path === 'web-player') traceMark(id, 'url');
  }, [id, path]);
  useEffect(() => {
    if (network) traceInfo(id, { network });
  }, [id, network]);

  const noSource = !!src.noSource;
  useEffect(() => {
    if (noSource) traceFail(id, 'no-source');
  }, [id, noSource]);
}
