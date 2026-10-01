import { useRef, useState } from 'react';
import { Text, View, type GestureResponderEvent } from 'react-native';

import { C, F, R, TABULAR } from '@/theme/tokens';

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
      style={{ flex: 1, height: 28, justifyContent: 'center' }}>
      <View style={{ height: scrub !== null ? 6 : 4, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.22)', overflow: 'hidden' }}>
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${buf * 100}%`, backgroundColor: 'rgba(255,255,255,0.32)' }} />
        <View style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${shown * 100}%`, backgroundColor: C.accentText }} />
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
          position: 'absolute', left: `${shown * 100}%`, marginLeft: -8, width: 16, height: 16, borderRadius: 8,
          backgroundColor: C.white, boxShadow: '0px 1px 4px rgba(0,0,0,0.5)', transform: [{ scale: scrub !== null ? 1.3 : 1 }],
        }}
      />
      {/* Scrub preview: the target time floats above the thumb. */}
      {scrub !== null && ok && (
        <View pointerEvents="none" style={{ position: 'absolute', bottom: 30, left: `${shown * 100}%`, width: 80, marginLeft: -40, alignItems: 'center' }}>
          <View style={{ paddingHorizontal: 10, paddingVertical: 5, borderRadius: R.chip, borderCurve: 'continuous', backgroundColor: 'rgba(12,17,28,0.92)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.14)' }}>
            <Text style={{ color: C.white, fontSize: 14, ...F.bold, ...TABULAR }}>{formatTime(scrub * duration)}</Text>
          </View>
        </View>
      )}
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
