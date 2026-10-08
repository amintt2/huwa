// Subtitle engine for the players: parsing lives in `@/subtitles`, drawing and UI here.
export { SubtitleOverlay, videoRect, type Insets, type SubtitleOverlayProps } from './SubtitleOverlay';
export { SubtitlePanel } from './SubtitlePanel';
export {
  cueAt,
  loadSubtitleDoc,
  parseSubtitles,
  useCues,
  useSubtitleController,
  type Cue,
  type ExternalSubtitle,
  type SubtitleController,
} from './useSubtitles';
