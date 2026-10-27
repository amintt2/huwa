// Lines of an embedded track read live from the video engine (see
// components/player/subtitles/live-translation.ts), kept as plain cues. Pure.

export type LiveCue = { start: number; end: number; text: string };

/** `list` with `cue` added: a line already there is kept; lines still shown at its start end there. */
export function addCue(list: LiveCue[], cue: LiveCue): LiveCue[] {
  if (list.some((c) => Math.abs(c.start - cue.start) < 0.05 && c.text === cue.text)) return list;
  // The engine reports what is on screen now: an earlier line still running has been replaced.
  const clipped = list.map((c) => (c.start < cue.start && c.end > cue.start ? { ...c, end: cue.start } : c));
  return [...clipped, cue];
}
