// Subtitle overlay: draws the events visible at the player's time over the video picture.
//
// Sync: the player reports its time 4×/s; between reports the overlay extrapolates from the last
// report (time + elapsed × rate) and schedules a re-render exactly at the next cue boundary, so
// lines appear / disappear on time without polling and without drift (every report re-anchors).
// Fades (\fad) animate per frame only while a fade is running.
//
// Outline: React Native has no text stroke. The text is drawn several times, shifted around a
// circle (outer ring + inner ring for thick contours) in the outline colour, with a hairline
// blur for anti-aliasing, then once in the fill colour on top. A drop shadow is the same ring,
// offset. This gives a clean, even contour like libass for 1-2 lines of dialogue.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Platform, StyleSheet, Text, View, type LayoutChangeEvent, type TextStyle } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { useSubtitlePrefs, type SubtitlePrefs } from '@/subtitles/prefs';
import { bandColor, renderEvent, type Rect, type RenderBlock, type RenderSpan } from '@/subtitles/render';
import { timelineOf } from '@/subtitles/timeline';
import type { SubEvent, SubtitleDoc } from '@/subtitles/types';

import { fontStyle, useSubtitleFonts } from './fonts';

// ---------- clock ----------

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

type View_ = { t: number; key: string };

/**
 * Subtitle time, re-rendered only when the visible set changes (or every frame during a fade).
 * `time` is the player time (s), `offset` the user delay (+ = subtitles later).
 */
function useSubtitleTime(doc: SubtitleDoc | null, time: number, playing: boolean, rate: number, offset: number): number {
  const [view, setView] = useState<View_>({ t: time - offset, key: '' });
  const timer = useRef<{ to?: ReturnType<typeof setTimeout>; raf?: number }>({});

  useEffect(() => {
    const anchor = { t: time - offset, at: now() };
    const speed = playing ? Math.max(0.1, rate) : 0;
    const current = () => anchor.t + ((now() - anchor.at) / 1000) * speed;
    const tl = doc ? timelineOf(doc) : null;
    const stop = () => {
      clearTimeout(timer.current.to);
      if (timer.current.raf) cancelAnimationFrame(timer.current.raf);
      timer.current = {};
    };

    const step = () => {
      stop();
      const t = current();
      const vis = tl ? tl.at(t) : [];
      const fading = vis.some((e) => isFading(e, t));
      const key = vis.map((e) => e.id).join(',');
      setView((v) => (v.key === key && !fading && Math.abs(v.t - t) < 5 ? v : { t, key }));
      if (!speed || !tl) return;
      if (fading) {
        timer.current.raf = requestAnimationFrame(step);
        return;
      }
      const next = Math.min(tl.nextChange(t), nextFadeStart(vis, t));
      if (isFinite(next)) timer.current.to = setTimeout(step, Math.max(0, ((next - t) / speed) * 1000) + 1);
    };
    step();
    return stop;
  }, [doc, time, playing, rate, offset]);

  return view.t;
}

const isFading = (e: SubEvent, t: number) =>
  !!e.fade && ((e.fade.in > 0 && t < e.start + e.fade.in / 1000) || (e.fade.out > 0 && t > e.end - e.fade.out / 1000));

/** When a visible event starts fading out (so the frame loop can start). */
function nextFadeStart(vis: SubEvent[], t: number) {
  let n = Infinity;
  for (const e of vis) if (e.fade && e.fade.out > 0) {
    const s = e.end - e.fade.out / 1000;
    if (s > t && s < n) n = s;
  }
  return n;
}

// ---------- geometry ----------

export type Insets = { top: number; bottom: number; left: number; right: number };
const NO_INSETS: Insets = { top: 0, bottom: 0, left: 0, right: 0 };

/** Picture rect of a `contain`-fitted video. */
export function videoRect(w: number, h: number, aspect: number | undefined): Rect {
  const a = aspect && isFinite(aspect) && aspect > 0 ? aspect : 16 / 9;
  if (w / h > a) {
    const vw = h * a;
    return { x: (w - vw) / 2, y: 0, width: vw, height: h };
  }
  const vh = w / a;
  return { x: 0, y: (h - vh) / 2, width: w, height: vh };
}

function ring(w: number): { x: number; y: number }[] {
  if (w <= 0.05) return [];
  const pts: { x: number; y: number }[] = [];
  const n = Math.min(16, Math.max(8, Math.round(w * 4)));
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    pts.push({ x: Math.cos(a) * w, y: Math.sin(a) * w });
  }
  if (w > 1.6) {
    for (let i = 0; i < 8; i++) {
      const a = ((i + 0.5) / 8) * Math.PI * 2;
      pts.push({ x: Math.cos(a) * w * 0.55, y: Math.sin(a) * w * 0.55 });
    }
  }
  return pts;
}

// ---------- text ----------

type Layer = 'fill' | 'outline' | 'shadow';

function spanStyle(s: RenderSpan, layer: Layer, fonts: string): TextStyle {
  const deco = s.underline && s.strike ? 'underline line-through' : s.underline ? 'underline' : s.strike ? 'line-through' : 'none';
  return {
    ...fontStyle(s.font, s.bold, s.italic, fonts),
    fontSize: s.fontSize,
    color: layer === 'fill' ? s.color : layer === 'outline' ? s.outlineColor : s.shadowColor,
    textDecorationLine: deco,
    textDecorationColor: layer === 'fill' ? s.color : layer === 'outline' ? s.outlineColor : s.shadowColor,
  };
}

function Runs({ block, layer, fonts }: { block: RenderBlock; layer: Layer; fonts: string }) {
  return block.spans.map((s, i) => (
    <Text key={i} style={spanStyle(s, layer, fonts)}>
      {s.text}
    </Text>
  ));
}

/** One subtitle event: shadow ring, outline ring, fill. */
export function OutlinedBlock({ block, fonts, maxWidth }: { block: RenderBlock; fonts: string; maxWidth: number }) {
  const outline = ring(block.outline);
  const shadowRing = block.shadow > 0 ? (block.outline > 0 ? ring(block.outline).filter((_, i) => i % 2 === 0) : [{ x: 0, y: 0 }]) : [];
  const base: TextStyle = { textAlign: block.textAlign, lineHeight: block.lineHeight, includeFontPadding: false };
  const soft = Math.min(1.2, Math.max(0.5, block.outline * 0.35));
  const pad = block.outline + block.shadow;
  const copies: ReactNode[] = [];
  shadowRing.forEach((p, i) => {
    copies.push(
      <Text key={`s${i}`} style={[base, styles.copy, { left: pad, right: pad, top: pad, transform: [{ translateX: p.x + block.shadow }, { translateY: p.y + block.shadow }] }]}>
        <Runs block={block} layer="shadow" fonts={fonts} />
      </Text>,
    );
  });
  outline.forEach((p, i) => {
    copies.push(
      <Text
        key={`o${i}`}
        style={[
          base,
          styles.copy,
          { left: pad, right: pad, top: pad, transform: [{ translateX: p.x }, { translateY: p.y }] },
          { textShadowColor: block.spans[0]?.outlineColor, textShadowRadius: soft, textShadowOffset: { width: 0, height: 0 } },
        ]}>
        <Runs block={block} layer="outline" fonts={fonts} />
      </Text>,
    );
  });

  const body = (
    // Padding keeps the contour inside the box (no clipping at the edges of the text frame).
    <View style={{ padding: pad, maxWidth }}>
      {copies}
      <Text style={base}>
        <Runs block={block} layer="fill" fonts={fonts} />
      </Text>
    </View>
  );
  return (
    <View style={{ opacity: block.opacity, maxWidth }}>
      {block.box ? (
        <View
          style={{
            backgroundColor: block.box.color,
            paddingHorizontal: Math.max(0, block.box.padH - pad),
            paddingVertical: Math.max(0, block.box.padV - pad),
            borderRadius: block.box.radius,
            borderCurve: 'continuous',
          }}>
          {body}
        </View>
      ) : (
        body
      )}
    </View>
  );
}

// ---------- overlay ----------

export type SubtitleOverlayProps = {
  doc: SubtitleDoc | null;
  /** Player time in seconds (as last reported). */
  time: number;
  playing: boolean;
  rate?: number;
  /** User sync delay in seconds (+ = subtitles later). */
  offset?: number;
  /** Video width / height (defaults to 16:9). */
  aspect?: number;
  /** Space to keep free at the bottom (player controls visible). */
  reserveBottom?: number;
  /** Safe-area insets (notch, home indicator) when the overlay covers the screen. */
  insets?: Insets;
  /** Style override (settings preview); defaults to the saved preferences. */
  prefs?: SubtitlePrefs;
};

const COL = ['flex-start', 'center', 'flex-end'] as const;

export function SubtitleOverlay({ doc, time, playing, rate = 1, offset = 0, aspect, reserveBottom = 0, insets = NO_INSETS, prefs: prefsProp }: SubtitleOverlayProps) {
  const saved = useSubtitlePrefs();
  const prefs = prefsProp ?? saved;
  const [size, setSize] = useState({ w: 0, h: 0 });
  const onLayout = (e: LayoutChangeEvent) => {
    const { width, height } = e.nativeEvent.layout;
    setSize((s) => (s.w === width && s.h === height ? s : { w: width, h: height }));
  };
  const t = useSubtitleTime(doc, time, playing, rate, offset);
  const visible = doc && size.w > 0 ? timelineOf(doc).at(t) : [];

  const fontIds = [prefs.font, ...(doc && prefs.respectAss ? ['mplus', 'comic', 'merriweather', 'mono'] as const : [])];
  const fonts = useSubtitleFonts(visible.length ? fontIds : [prefs.font]);

  if (!doc || !visible.length || !size.w) return <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout} />;

  const video = videoRect(size.w, size.h, aspect);
  const blocks = visible.map((e) => renderEvent(e, doc, { prefs, video, t }, Platform.OS));
  const band = bandColor(prefs);

  // Horizontal safe band: the picture, minus notch / rounded corners when full screen.
  const safeL = Math.max(video.x, insets.left);
  const safeR = Math.min(video.x + video.width, size.w - insets.right);
  const bottomEdge = Math.min(video.y + video.height, size.h - insets.bottom);
  const topEdge = Math.max(video.y, insets.top);

  const slots = new Map<number, RenderBlock[]>();
  const anchors: RenderBlock[] = [];
  for (const b of blocks) {
    if (b.placement.kind === 'anchor') anchors.push(b);
    else slots.set(b.placement.slot, [...(slots.get(b.placement.slot) ?? []), b]);
  }

  return (
    <View pointerEvents="none" style={StyleSheet.absoluteFill} onLayout={onLayout}>
      {anchors.map((b) => {
        if (b.placement.kind !== 'anchor') return null;
        const { x, y, align } = b.placement;
        const col = (align - 1) % 3;
        const row = align >= 7 ? 'top' : align >= 4 ? 'middle' : 'bottom';
        const W = size.w;
        const H = size.h;
        const horiz = col === 0 ? { left: x, width: W } : col === 1 ? { left: x - W, width: 2 * W } : { left: x - W, width: W };
        const vert = row === 'top' ? { top: y, height: H } : row === 'middle' ? { top: y - H, height: 2 * H } : { top: y - H, height: H };
        return (
          <View key={b.key} style={[styles.abs, horiz, vert, { alignItems: COL[col], justifyContent: row === 'top' ? 'flex-start' : row === 'middle' ? 'center' : 'flex-end' }]}>
            <OutlinedBlock block={b} fonts={fonts} maxWidth={video.width * 0.96} />
          </View>
        );
      })}
      {[...slots.entries()].map(([slot, list]) => {
        const first = list[0].placement;
        if (first.kind !== 'slot') return null;
        const col = (slot - 1) % 3;
        const row = slot >= 7 ? 'top' : slot >= 4 ? 'middle' : 'bottom';
        const left = Math.max(safeL, video.x + first.marginL);
        const right = size.w - Math.min(safeR, video.x + video.width - first.marginR);
        const useBand = !!band && row === 'bottom' && list.every((b) => b.user);
        const lift = row === 'bottom' ? Math.max(first.marginV, reserveBottom - (size.h - bottomEdge)) : 0;
        const vert =
          row === 'bottom'
            ? { bottom: size.h - bottomEdge + lift }
            : row === 'top'
              ? { top: topEdge + first.marginV }
              : { top: video.y, height: video.height, justifyContent: 'center' as const };
        // Collisions: the first line keeps its place, later ones move away from the edge.
        const ordered = row === 'bottom' ? [...list].reverse() : list;
        return (
          <Animated.View
            key={`slot${slot}`}
            layout={LinearTransition.duration(180)}
            style={[
              styles.abs,
              { left: useBand ? video.x : left, right: useBand ? size.w - video.x - video.width : right, alignItems: COL[col] },
              vert,
              useBand && { backgroundColor: band, paddingVertical: list[0].lineHeight * 0.18, paddingHorizontal: left - video.x },
            ]}>
            {ordered.map((b) => (
              <OutlinedBlock key={b.key} block={b} fonts={fonts} maxWidth={safeR - safeL} />
            ))}
          </Animated.View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  abs: { position: 'absolute' },
  copy: { position: 'absolute' },
});
