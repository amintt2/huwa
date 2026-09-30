// Subtitle document model shared by every format (ASS/SSA, SRT, WebVTT).
// Parsers produce a `SubtitleDoc`; the overlay only knows this model.

export type SubtitleFormat = 'ass' | 'ssa' | 'srt' | 'vtt';

/** Colour as RGBA, alpha in 0..1 (ASS alpha is inverted and converted on parse). */
export type Rgba = { r: number; g: number; b: number; a: number };

/** A resolved ASS style ([V4+ Styles] line). Sizes are in script pixels (PlayResY). */
export type AssStyle = {
  name: string;
  fontName: string;
  fontSize: number;
  primary: Rgba;
  secondary: Rgba;
  outline: Rgba;
  back: Rgba;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  scaleX: number;
  scaleY: number;
  spacing: number;
  /** 1 = outline + shadow, 3 = opaque box. */
  borderStyle: number;
  outlineWidth: number;
  shadow: number;
  /** Numpad alignment 1..9 (\an). */
  alignment: number;
  marginL: number;
  marginR: number;
  marginV: number;
};

/** Inline overrides carried by a run of text ({\i1}, {\c&H..&}, <i>, <font color>…). */
export type SpanStyle = {
  italic?: boolean;
  bold?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: Rgba;
  outlineColor?: Rgba;
  shadowColor?: Rgba;
  /** Script pixels. */
  fontSize?: number;
  fontName?: string;
  /** Script pixels. */
  outlineWidth?: number;
  shadow?: number;
};

/** `text` may contain '\n' (hard line breaks). */
export type Span = { text: string; style: SpanStyle };

export type SubEvent = {
  /** Stable id (index in the file) — React key. */
  id: number;
  start: number;
  end: number;
  layer: number;
  /** Base style (ASS style, or the default style for SRT/VTT). */
  style: AssStyle;
  spans: Span[];
  /** Numpad alignment 1..9 after overrides. */
  align: number;
  /** \pos / \move start, in script pixels. */
  pos?: { x: number; y: number };
  /** Event margins (0 = style margin), script pixels. */
  marginL: number;
  marginR: number;
  marginV: number;
  /** \fad(in, out) in ms. */
  fade?: { in: number; out: number };
  /** Plain text (tags stripped), for search / dedupe / tests. */
  plain: string;
};

export type SubtitleDoc = {
  format: SubtitleFormat;
  playResX: number;
  playResY: number;
  /** ASS ScaledBorderAndShadow (borders scale with the video). */
  scaledBorder: boolean;
  /** 0 smart, 1 end-of-line, 2 no wrap, 3 smart (lower wider). */
  wrapStyle: number;
  styles: Record<string, AssStyle>;
  /** Sorted by start time. */
  events: SubEvent[];
};
