import { useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';

import { C } from '@/theme/tokens';

/** Scrubbable progress bar: drag to preview, release to seek. */
export function SeekBar({
  position,
  duration,
  buffered,
  onSeek,
  onScrubStart,
  markers = [],
}: {
  position: number;
  duration: number;
  buffered: number;
  onSeek: (t: number) => void;
  onScrubStart?: () => void;
  /** Highlighted ranges (opening / ending) drawn on the track. */
  markers?: { start: number; end: number }[];
}) {
  const box = useRef<View>(null);
  const frame = useRef({ x: 0, w: 1 });
  const [scrub, setScrub] = useState<number | null>(null);
  const ok = duration > 0 && isFinite(duration);

  const ratioOf = (e: GestureResponderEvent) =>
    Math.min(1, Math.max(0, (e.nativeEvent.pageX - frame.current.x) / frame.current.w));

  const shown = scrub ?? (ok ? position / duration : 0);
  const buf = ok ? Math.min(1, Math.max(0, buffered / duration)) : 0;

  return (
    <View
      ref={box}
      onLayout={() => box.current?.measureInWindow((x, _y, w) => (frame.current = { x, w: Math.max(1, w) }))}
      onStartShouldSetResponder={() => ok}
      onMoveShouldSetResponder={() => ok}
      onResponderTerminationRequest={() => false}
      onResponderGrant={(e) => {
        onScrubStart?.();
        // Re-measure: the bar may have moved (rotation, fullscreen).
        box.current?.measureInWindow((x, _y, w) => (frame.current = { x, w: Math.max(1, w) }));
        setScrub(ratioOf(e));
      }}
      onResponderMove={(e) => setScrub(ratioOf(e))}
      onResponderRelease={(e) => {
        const r = ratioOf(e);
        setScrub(null);
        onSeek(r * duration);
      }}
      onResponderTerminate={() => setScrub(null)}
      accessibilityRole="adjustable"
      accessibilityLabel="Position de lecture"
      accessibilityValue={{ min: 0, max: Math.round(duration || 0), now: Math.round(position) }}
      accessibilityActions={[{ name: 'increment' }, { name: 'decrement' }]}
      onAccessibilityAction={(e) => onSeek(position + (e.nativeEvent.actionName === 'increment' ? 10 : -10))}
      hitSlop={{ top: 14, bottom: 14 }}
      style={{ flex: 1, height: 24, justifyContent: 'center' }}>
      <View style={{ height: scrub !== null ? 6 : 4, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${buf * 100}%`, backgroundColor: 'rgba(255,255,255,0.35)' }} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${shown * 100}%`, backgroundColor: C.accent }} />
        {ok && markers.map((m) => (
          <View
            key={`${m.start}-${m.end}`}
            pointerEvents="none"
            style={{
              position: 'absolute', top: 0, bottom: 0, left: `${(m.start / duration) * 100}%`,
              width: `${(Math.max(0, Math.min(duration, m.end) - m.start) / duration) * 100}%`, backgroundColor: 'rgba(255,200,87,0.85)',
            }}
          />
        ))}
      </View>
      <View
        pointerEvents="none"
        style={{
          position: 'absolute', left: `${shown * 100}%`, marginLeft: -7, width: 14, height: 14, borderRadius: 7,
          backgroundColor: C.white, transform: [{ scale: scrub !== null ? 1.25 : 1 }],
        }}
      />
    </View>
  );
}

export function formatTime(s: number) {
  if (!isFinite(s) || s < 0) s = 0;
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = h ? String(m).padStart(2, '0') : String(m);
  return `${h ? `${h}:` : ''}${mm}:${String(sec).padStart(2, '0')}`;
}
