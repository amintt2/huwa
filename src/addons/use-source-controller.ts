// Wiring of the source controller (./source-controller.ts, the rules) between the source list
// (./use-source.ts) and the player (components/player: PlaybackMonitor for what it observes, the
// seamless switch for warm swaps). Every 2 s while a source plays: one `step`, then its answer is
// applied — re-probes, a warm-up request for the player, a switch at the current position, a
// broken source dropped. Each switch becomes an anonymous stats event (reason, stalls before and
// after). No re-render unless something changes.
import { useEffect, useRef, useState } from 'react';
import { PixelRatio, useWindowDimensions } from 'react-native';

import type { UpgradeRequest } from '@/components/player/seamless-upgrade';
import type { PlaybackMonitor } from '@/components/player/playback-monitor';
import { deviceCaps } from '@/components/player/engines';
import { useNetClass } from '@/settings/network';
import { useSettings } from '@/settings/settings';
import type { SwitchEvent } from '@/stats/model';
import { recordSwitch } from '@/stats/store';
import { peerClock } from '@/torrent/use-peer-race';

import {
  deviceMaxResolution,
  failed,
  initialState,
  prepareFailed,
  step,
  switched,
  switchToast,
  type CtlCandidate,
  type CtlState,
  type EpisodeInfo,
  type SwitchReason,
} from './source-controller';
import type { useSource } from './use-source';

type Source = ReturnType<typeof useSource>;

const TICK_MS = 2000;
/** Stalls of the new source are watched this long after a switch (stats). */
const AFTER_WINDOW_MS = 120_000;
const BEFORE_WINDOW_MS = 90_000;

export type SwitchRequest = UpgradeRequest & { reason: SwitchReason };
export type LastSwitch = { reason: SwitchReason; fromRes: number; toRes: number; at: number };

type Pending = { ev: SwitchEvent; toKey?: string; startedAt: number | null };

export function useSourceController(src: Source, monitor: PlaybackMonitor, opts: { episode: EpisodeInfo; enabled: boolean }) {
  const settings = useSettings();
  const net = useNetClass();
  const win = useWindowDimensions();
  const deviceMaxRes = deviceMaxResolution({
    longSidePx: Math.max(win.width, win.height) * PixelRatio.get(),
    // iPhones since the A9 decode HEVC in hardware; unknown (no mpv module) counts as yes.
    hevcHw: deviceCaps().hw.hevc ?? true,
  });

  const state = useRef<CtlState>(initialState());
  const srcRef = useRef(src);
  const cfg = useRef({ settings, net, deviceMaxRes, episode: opts.episode });
  useEffect(() => {
    srcRef.current = src;
    cfg.current = { settings, net, deviceMaxRes, episode: opts.episode };
  });
  const [request, setRequest] = useState<SwitchRequest | null>(null);
  const requestRef = useRef<SwitchRequest | null>(null);
  const [toast, setToast] = useState<{ text: string; at: number } | null>(null);
  const [last, setLast] = useState<LastSwitch | null>(null);
  const pending = useRef<Pending | null>(null);
  /** Kind / resolution of the source a pending request leaves (stats of a seamless swap). */
  const leaving = useRef<{ kind: 'http' | 'torrent'; res: number; stalls: number; stalledMs: number; net: SwitchEvent['net'] } | null>(null);

  const ask = (r: SwitchRequest | null) => {
    requestRef.current = r;
    setRequest(r);
  };

  const netStat = (): SwitchEvent['net'] => {
    const n = cfg.current.net;
    return n === 'unmetered' || n === 'cellular' || n === 'metered' ? n : undefined;
  };

  /** Ends the stats window of the previous switch (on a new switch, or when the screen goes). */
  const finish = () => {
    const p = pending.current;
    pending.current = null;
    if (!p) return;
    if (p.startedAt != null) {
      const after = monitor.stallsSince(p.startedAt);
      p.ev.stallsAfter = after.count;
      p.ev.stalledMsAfter = after.ms;
      p.ev.afterMs = Math.min(AFTER_WINDOW_MS, Date.now() - p.startedAt);
    }
    try {
      recordSwitch(p.ev);
    } catch {
      // stats never break playback
    }
  };

  const begin = (ev: SwitchEvent, toKey?: string, startedAt: number | null = null) => {
    finish();
    pending.current = { ev, toKey, startedAt };
  };

  const before = () => {
    const s = monitor.stallsSince(Date.now() - BEFORE_WINDOW_MS);
    return { stallsBefore: s.count, stalledMsBefore: s.ms };
  };

  /** Candidates of the last decision (kind / resolution of a switch target, for the stats). */
  const candidatesRef = useRef<CtlCandidate[]>([]);
  const resOf = (key: string) => candidatesRef.current.find((c) => c.key === key);

  // One decision every 2 s while a source plays.
  useEffect(() => {
    if (!opts.enabled) return;
    const id = setInterval(() => {
      const s = srcRef.current;
      const c = cfg.current;
      const now = Date.now();
      const p0 = pending.current;
      // Stats of the last switch: when its source started, and the end of its window.
      if (p0 && monitor.uri && monitor.uri === s.url) {
        const snap = monitor.snapshot();
        if (p0.startedAt == null && snap.started && (!p0.toKey || s.currentKey === p0.toKey)) {
          p0.startedAt = now - snap.sincePlayMs;
          p0.ev.tSwitch = Math.max(0, Math.round(p0.startedAt - p0.ev.at));
          if (p0.ev.mode !== 'seamless' && c.settings.switchToast) {
            setToast({ text: switchToast(p0.ev.reason, p0.ev.fromRes, p0.ev.toRes ?? 0), at: now });
          }
        }
        if (p0.startedAt != null && now - p0.startedAt >= AFTER_WINDOW_MS) finish();
      }

      const view = s.controllerView(now, peerClock());
      const cur = view.current;
      // Picked by hand / hosted page / nothing playing: no warm-up may stay pending.
      if (!cur && (requestRef.current || state.current.preparing)) {
        ask(null);
        state.current = { ...state.current, preparing: null };
      }
      // Between two sources (resolving, loading the new URL): nothing to observe yet.
      if (!cur || !s.url || monitor.uri !== s.url) return;
      candidatesRef.current = view.candidates;
      const r = step(state.current, {
        now,
        current: cur,
        currentExempt: view.exempt,
        currentEpisodes: view.episodes,
        playback: monitor.snapshot(),
        candidates: view.candidates,
        settings: { auto: c.settings.autoSwitchSource, net: c.net, deviceMaxRes: c.deviceMaxRes },
        episode: c.episode,
      });
      state.current = r.state;
      if (r.reprobe.length) s.reprobe(r.reprobe);
      const a = r.action;
      if (a.type === 'hold') return;
      if (a.type === 'cancel') {
        if (requestRef.current?.key === a.key) ask(null);
        return;
      }
      const target = a.type === 'drop' ? undefined : resOf(a.key);
      const base = {
        at: now,
        reason: a.reason,
        net: netStat(),
        fromKind: cur.kind,
        toKind: target?.kind,
        fromRes: cur.resolution,
        toRes: target?.resolution,
        ...before(),
      };
      if (a.type === 'prepare') {
        const t = s.warmTarget(a.key);
        if (!t) {
          state.current = prepareFailed(state.current, a.key, a.reason);
          return;
        }
        leaving.current = { kind: cur.kind, res: cur.resolution, stalls: base.stallsBefore, stalledMs: base.stalledMsBefore, net: base.net };
        ask({ key: t.key, uri: t.uri, headers: t.headers, urgent: a.reason !== 'upgrade', reason: a.reason });
        return;
      }
      ask(null);
      if (a.type === 'switch') {
        begin({ ...base, mode: 'hard' }, a.key);
        state.current = switched(state.current, a.key, a.reason, now);
        setLast({ reason: a.reason, fromRes: cur.resolution, toRes: target?.resolution ?? 0, at: now });
        s.switchTo(a.key);
        return;
      }
      // drop: another work under the same title (file length), handled like a broken source.
      begin({ ...base, mode: 'drop' });
      state.current = switched(state.current, a.key, a.reason, now);
      setLast({ reason: a.reason, fromRes: cur.resolution, toRes: 0, at: now });
      s.markBad(a.key, 'Autre vidéo que l’épisode (durée différente)', true);
    }, TICK_MS);
    return () => clearInterval(id);
    // The helpers only read refs: the timer is set once per screen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [opts.enabled, monitor]);

  // Leaving the screen: the last switch's stats are recorded with what was observed.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => () => finish(), []);

  /** The player swapped to the warm source (seamless). */
  const onSwapped = (key: string) => {
    const req = requestRef.current;
    const reason = req?.key === key ? req.reason : 'upgrade';
    const now = Date.now();
    const l = leaving.current;
    const target = resOf(key);
    state.current = switched(state.current, key, reason, now);
    begin(
      {
        at: now,
        reason,
        mode: 'seamless',
        net: l?.net ?? netStat(),
        fromKind: l?.kind ?? 'http',
        toKind: target?.kind ?? 'http',
        fromRes: l?.res ?? 0,
        toRes: target?.resolution,
        stallsBefore: l?.stalls ?? 0,
        stalledMsBefore: l?.stalledMs ?? 0,
        tSwitch: 0,
      },
      key,
      now,
    );
    leaving.current = null;
    setLast({ reason, fromRes: l?.res ?? 0, toRes: target?.resolution ?? 0, at: now });
    if (cfg.current.settings.switchToast) setToast({ text: switchToast(reason, l?.res ?? 0, target?.resolution ?? 0), at: now });
    ask(null);
    srcRef.current.adoptUpgrade(key);
  };

  /** The warm-up failed (stalled, error, other engine, other cut): playback untouched. */
  const onDeferred = (key: string) => {
    const req = requestRef.current;
    const reason = req?.key === key ? req.reason : 'upgrade';
    state.current = prepareFailed(state.current, key, reason);
    if (reason === 'upgrade') srcRef.current.deferUpgrade(key);
    leaving.current = null;
    ask(null);
  };

  /** A source failed to play (player error): never a target again for this episode. */
  const onFailed = (key: string) => {
    state.current = failed(state.current, key);
  };

  return { request, onSwapped, onDeferred, onFailed, toast, last };
}
