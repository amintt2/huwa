// Touch surface over the video, YouTube-style:
// - single tap: show / hide the controls
// - double tap on the left / right half: -10 s / +10 s
// - vertical drag (fullscreen only): left half = screen brightness, right half = volume
// - pinch (fullscreen only): open = zoom to fill the screen, close = whole picture
// Built on the JS responder system (PanResponder): it sits under the controls, so buttons and the
// seek bar keep their own touches, and it doesn't need a gesture-handler root view.
import * as Brightness from 'expo-brightness';
import { useEffect, useState } from 'react';
import { PanResponder, Platform, StyleSheet, View, type GestureResponderEvent, type PanResponderGestureState } from 'react-native';

export type Hud = { kind: 'volume' | 'brightness'; value: number };

type Props = {
  width: number;
  height: number;
  /** Brightness / volume drags. */
  adjust: boolean;
  seekEnabled: boolean;
  onTap: () => void;
  onDoubleTap: (side: 'left' | 'right') => void;
  getVolume: () => number;
  setVolume: (v: number) => void;
  onHud: (hud: Hud | null) => void;
  /** Two-finger pinch: true = fill (zoom in), false = fit. */
  onPinch?: (fill: boolean) => void;
};

const DOUBLE_TAP_MS = 260;
const TAP_SLOP = 10;

// Session state lives outside React: responder callbacks mutate it on every move.
class Session {
  props!: Props;
  lastTap = 0;
  lastSide: 'left' | 'right' = 'left';
  tapTimer: ReturnType<typeof setTimeout> | undefined;
  drag: { kind: Hud['kind']; value: number } | null = null;
  brightness: number | null = null;
  original: number | null = null;
  startX = 0;
  pinch: { start: number; done: boolean } | null = null;

  setProps(p: Props) {
    this.props = p;
  }

  readBrightness() {
    if (this.brightness != null) return;
    Brightness.getBrightnessAsync()
      .then((b) => {
        this.brightness = b;
        if (this.original == null) this.original = b;
      })
      .catch(() => {});
  }

  restoreBrightness() {
    clearTimeout(this.tapTimer);
    const original = this.original;
    this.original = null;
    this.brightness = null;
    if (original == null) return;
    if (Platform.OS === 'android') Brightness.restoreSystemBrightnessAsync().catch(() => {});
    else Brightness.setBrightnessAsync(original).catch(() => {});
  }

  isDrag(g: PanResponderGestureState) {
    return !!this.props?.adjust && Math.abs(g.dy) > 12 && Math.abs(g.dy) > Math.abs(g.dx) * 1.5;
  }

  pinchMove(e: GestureResponderEvent): boolean {
    const t = e.nativeEvent.touches;
    if (!this.props.onPinch || t.length < 2) return false;
    const d = Math.hypot(t[0].pageX - t[1].pageX, t[0].pageY - t[1].pageY);
    if (!this.pinch) this.pinch = { start: d, done: false };
    else if (!this.pinch.done && (d / this.pinch.start > 1.15 || d / this.pinch.start < 0.87)) {
      this.pinch.done = true;
      this.props.onPinch(d > this.pinch.start);
    }
    if (this.drag) this.cancel();
    return true;
  }

  grant(e: GestureResponderEvent) {
    this.drag = null;
    this.pinch = null;
    this.startX = e.nativeEvent.locationX;
    if (this.props.adjust) this.readBrightness();
  }

  move(g: PanResponderGestureState) {
    const p = this.props;
    if (!this.drag) {
      if (!this.isDrag(g)) return;
      const kind = this.startX < p.width / 2 ? 'brightness' : 'volume';
      this.drag = { kind, value: kind === 'volume' ? p.getVolume() : (this.brightness ?? 0.5) };
    }
    const value = Math.min(1, Math.max(0, this.drag.value - g.dy / (p.height * 0.75)));
    if (this.drag.kind === 'volume') p.setVolume(value);
    else {
      this.brightness = value;
      Brightness.setBrightnessAsync(value).catch(() => {});
    }
    p.onHud({ kind: this.drag.kind, value });
  }

  release(g: PanResponderGestureState) {
    const p = this.props;
    if (this.pinch) {
      this.pinch = null;
      return;
    }
    if (this.drag) {
      this.drag = null;
      p.onHud(null);
      return;
    }
    if (Math.abs(g.dx) > TAP_SLOP || Math.abs(g.dy) > TAP_SLOP) return;
    const side = this.startX < p.width / 2 ? 'left' : 'right';
    const now = Date.now();
    if (p.seekEnabled && now - this.lastTap < DOUBLE_TAP_MS && side === this.lastSide) {
      clearTimeout(this.tapTimer);
      this.lastTap = now; // keep chaining: triple tap = ±20 s
      p.onDoubleTap(side);
      return;
    }
    this.lastTap = now;
    this.lastSide = side;
    clearTimeout(this.tapTimer);
    // Wait for a possible second tap before toggling the controls.
    this.tapTimer = setTimeout(() => this.props.onTap(), p.seekEnabled ? DOUBLE_TAP_MS : 0);
  }

  cancel() {
    if (!this.drag) return;
    this.drag = null;
    this.props.onHud(null);
  }
}

export function GestureLayer(props: Props) {
  const [session] = useState(() => new Session());
  const [responder] = useState(() =>
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onMoveShouldSetPanResponder: (e, g) => e.nativeEvent.touches.length > 1 || session.isDrag(g),
      onPanResponderTerminationRequest: () => !session.drag,
      onPanResponderGrant: (e) => session.grant(e),
      onPanResponderMove: (e, g) => {
        if (!session.pinchMove(e) && !session.pinch) session.move(g);
      },
      onPanResponderRelease: (_e, g) => session.release(g),
      onPanResponderTerminate: () => session.cancel(),
    }),
  );
  useEffect(() => {
    session.setProps(props);
  });
  // Put the screen brightness back when leaving the player (iOS keeps it until the device locks).
  useEffect(() => () => session.restoreBrightness(), [session]);

  return <View style={StyleSheet.absoluteFill} {...responder.panHandlers} />;
}
