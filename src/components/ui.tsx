import Ionicons from '@expo/vector-icons/Ionicons';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import * as Haptics from 'expo-haptics';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  View,
  type PressableProps,
  type StyleProp,
  type TextProps,
  type ViewStyle,
} from 'react-native';
import Animated, { Easing, useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import type { Palette } from '@/data/catalog';
import { C, DUR, EASE_OUT, F, H, R, S, SHADOW, TABULAR, kindIcon, kindLabel, type Kind } from '@/theme/tokens';

export type IconName = ComponentProps<typeof Ionicons>['name'];

const ease = Easing.bezier(...EASE_OUT);
const GLASS = isLiquidGlassAvailable();

// ---------- Text ----------

/**
 * Type ramp (SF Pro): one display size per screen, sentence case everywhere; only `caption`
 * — the small overline label — is uppercase. Negative tracking on large sizes, as iOS does.
 */
const variants = {
  /** Screen / hero titles — the one display size per screen. */
  display: { ...F.heavy, fontSize: 32, lineHeight: 37, letterSpacing: -0.8, color: C.text },
  title: { ...F.bold, fontSize: 24, lineHeight: 29, letterSpacing: -0.5, color: C.text },
  /** Section and rail headings. */
  section: { ...F.bold, fontSize: 20, lineHeight: 25, letterSpacing: -0.4, color: C.text },
  headline: { ...F.semibold, fontSize: 17, lineHeight: 22, letterSpacing: -0.3, color: C.text },
  body: { ...F.regular, fontSize: 15, lineHeight: 21, letterSpacing: -0.1, color: C.text2 },
  label: { ...F.semibold, fontSize: 15, lineHeight: 20, letterSpacing: -0.15, color: C.text },
  small: { ...F.medium, fontSize: 13, lineHeight: 17, color: C.text2 },
  footnote: { ...F.medium, fontSize: 12, lineHeight: 16, color: C.text2 },
  /** Overline label: small, uppercase, tracked out. */
  caption: { ...F.bold, fontSize: 11, lineHeight: 14, letterSpacing: 0.7, textTransform: 'uppercase', color: C.text2 },
} as const;

export type TextVariant = keyof typeof variants;

/**
 * Large titles grow with Dynamic Type only so far: at the largest sizes a single word
 * ("Bibliothèque") no longer fit the width and iOS broke it mid-word. Body text is not capped.
 */
const MAX_SCALE: Partial<Record<TextVariant, number>> = { display: 1.3, section: 1.5, title: 1.5, caption: 1.6 };

export function Txt({
  v = 'body',
  color,
  style,
  tabular,
  ...rest
}: TextProps & { v?: TextVariant; color?: string; tabular?: boolean }) {
  return <Text maxFontSizeMultiplier={MAX_SCALE[v]} {...rest} style={[variants[v], tabular && TABULAR, color ? { color } : null, style]} />;
}

/** The HUWA wordmark: heavy, tracked, with the accent dot. */
export function Wordmark({ size = 24 }: { size?: number }) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: size * 0.16 }} accessibilityRole="header" accessibilityLabel="Huwa">
      <Text allowFontScaling={false} style={{ ...F.black, fontSize: size, lineHeight: size * 1.05, letterSpacing: size * 0.04, color: C.text }}>HUWA</Text>
      <View style={{ width: size * 0.26, height: size * 0.26, borderRadius: size, backgroundColor: C.accentText, marginBottom: size * 0.14 }} />
    </View>
  );
}

// ---------- Press feedback: scale on press-in (110 ms), back in 180 ms ----------

const APressable = Animated.createAnimatedComponent(Pressable);

type HapticKind = 'light' | 'medium' | 'select';

export function haptic(kind: HapticKind = 'light') {
  if (process.env.EXPO_OS !== 'ios') return;
  if (kind === 'select') Haptics.selectionAsync().catch(() => {});
  else Haptics.impactAsync(kind === 'medium' ? Haptics.ImpactFeedbackStyle.Medium : Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}

export function Press({
  style,
  onPressIn,
  onPressOut,
  onPress,
  scaleTo = 0.97,
  haptics,
  ...rest
}: PressableProps & { style?: StyleProp<ViewStyle>; scaleTo?: number; haptics?: HapticKind }) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <APressable
      {...rest}
      onPress={(e) => {
        if (haptics) haptic(haptics);
        onPress?.(e);
      }}
      onPressIn={(e) => {
        scale.set(withTiming(scaleTo, { duration: DUR.press, easing: ease }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withTiming(1, { duration: DUR.release, easing: ease }));
        onPressOut?.(e);
      }}
      style={[style, anim]}
    />
  );
}

// ---------- Tags & badges ----------

/** Small tag (genres, type, status), sentence case. `accent` / `bridge` = tinted blue. */
export function Chip({ kind, label }: { kind: Kind | 'neutral' | 'bridge' | 'accent'; label?: string }) {
  const text = label ?? (kind === 'anime' || kind === 'manhwa' ? kindLabel(kind) : '');
  const tinted = kind === 'bridge' || kind === 'accent';
  return (
    <View style={[styles.chip, tinted && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      {kind === 'bridge' && <Ionicons name="swap-horizontal" size={12} color={C.accentText} />}
      <Text maxFontSizeMultiplier={1.4} style={[styles.chipText, tinted && { color: C.accentText }]}>{text}</Text>
    </View>
  );
}

/** Small badge pinned on a poster corner ("Anime", "Manhwa"). */
export function TypeBadge({ kind, style }: { kind: Kind; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.typeBadge, style]}>
      <Ionicons name={kindIcon(kind)} size={10} color={C.text} />
      <Text maxFontSizeMultiplier={1.3} style={styles.typeBadgeText}>{kind === 'anime' ? 'Anime' : 'Manhwa'}</Text>
    </View>
  );
}

/** Info pill with icon: "Épisode 14", "15:04", "Chapitre 142". */
export function InfoPill({ icon, label, tone = 'neutral' }: { icon: IconName; label: string; tone?: 'neutral' | 'accent' }) {
  const accent = tone === 'accent';
  return (
    <View style={[styles.info, accent && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      <Ionicons name={icon} size={12} color={accent ? C.accentText : C.text2} />
      <Txt v="footnote" color={accent ? C.accentText : C.body} style={F.semibold} tabular numberOfLines={1}>
        {label}
      </Txt>
    </View>
  );
}

/** "2025 · 24 épisodes · Action" — metadata line, dot-separated, tabular numbers. */
export function MetaLine({ items, color = C.body, style, center }: { items: (string | false | null | undefined | ReactNode)[]; color?: string; style?: StyleProp<ViewStyle>; center?: boolean }) {
  const parts = items.filter((x) => x !== false && x !== null && x !== undefined && x !== '');
  return (
    <View style={[{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', columnGap: 7, rowGap: 2 }, center && { justifyContent: 'center' }, style]}>
      {parts.map((p, i) => (
        <View key={i} style={{ flexDirection: 'row', alignItems: 'center', columnGap: 7 }}>
          {i > 0 && <View style={{ width: 3, height: 3, borderRadius: 2, backgroundColor: color, opacity: 0.6 }} />}
          {typeof p === 'string' ? <Txt v="small" color={color} tabular style={F.medium}>{p}</Txt> : p}
        </View>
      ))}
    </View>
  );
}

// ---------- Cover art (placeholder until real key art) ----------

export function Cover({
  palette,
  image,
  imageHeaders,
  width,
  height,
  radius = R.poster,
  shade,
  dim,
  outline = true,
  children,
  style,
}: {
  palette: Palette;
  /** Real poster; the gradient art stays underneath as the loading placeholder. */
  image?: string;
  /** Request headers for the image (e.g. a Referer required by a manga source's CDN). */
  imageHeaders?: Record<string, string>;
  width?: number | `${number}%`;
  height: number;
  radius?: number;
  shade?: boolean | 'strong';
  dim?: boolean;
  /** 1 px white ring at 10 % — off for full-bleed art, where it would draw a seam. */
  outline?: boolean;
  children?: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const [a, b, c] = palette;
  const w = typeof width === 'number' ? width : 400;
  return (
    <View
      style={[
        { width: width ?? '100%', height, borderRadius: radius, borderCurve: 'continuous', overflow: 'hidden', backgroundColor: a },
        style,
      ]}>
      <LinearGradient colors={[a, b, c]} locations={[0, 0.62, 1]} start={{ x: 0, y: 0 }} end={{ x: 1, y: 1 }} style={StyleSheet.absoluteFill} />
      <View style={{ position: 'absolute', width: w * 0.9, height: w * 0.9, borderRadius: w, backgroundColor: c, opacity: 0.3, left: w * 0.38, top: -w * 0.32 }} />
      <View style={{ position: 'absolute', width: w * 0.55, height: w * 0.55, borderRadius: w, borderWidth: w * 0.02, borderColor: c, opacity: 0.35, left: w * 0.52, top: -w * 0.1 }} />
      <View style={{ position: 'absolute', width: w * 0.7, height: w * 0.7, borderRadius: w, backgroundColor: a, opacity: 0.75, left: -w * 0.25, top: height * 0.52 }} />
      <View
        style={{
          position: 'absolute', left: w * 0.2, top: height * 0.55, width: 0, height: 0,
          borderLeftWidth: w * 0.375, borderRightWidth: w * 0.375, borderBottomWidth: height * 0.5,
          borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: 'rgba(5,7,13,0.55)',
        }}
      />
      {image && (
        <Image source={imageHeaders ? { uri: image, headers: imageHeaders } : image} style={StyleSheet.absoluteFill} contentFit="cover" transition={200} cachePolicy="memory-disk" recyclingKey={image} />
      )}
      {shade && (
        <LinearGradient
          colors={['rgba(5,7,13,0)', shade === 'strong' ? 'rgba(5,7,13,0.85)' : 'rgba(5,7,13,0.6)', C.bg]}
          locations={shade === 'strong' ? [0.2, 0.7, 1] : [0.35, 0.8, 1]}
          style={StyleSheet.absoluteFill}
        />
      )}
      {dim && <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(5,7,13,0.55)' }]} />}
      {/* 1px white outline at 10% — consistent depth on dark surfaces */}
      {outline && (
        <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }]} />
      )}
      {children}
    </View>
  );
}

// ---------- Progress ----------

export function Progress({ value, color = C.accentText, track = 'rgba(255,255,255,0.14)', height = 3 }: { value: number; color?: string; track?: string; height?: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  return (
    <View
      style={{ height, backgroundColor: track, borderRadius: height, overflow: 'hidden' }}
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: pct }}>
      <View style={{ width: `${pct}%`, height, borderRadius: height, backgroundColor: color }} />
    </View>
  );
}

// ---------- Buttons ----------

/** Floating round button — real Liquid Glass on iOS 26+, frosted fallback elsewhere. */
export function IconButton({
  icon,
  onPress,
  size = 44,
  tone = 'glass',
  color = C.text,
  label,
  right,
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  tone?: 'glass' | 'solid' | 'plain';
  color?: string;
  label: string;
  right?: ReactNode;
}) {
  const round = { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' } as const;
  // Chevrons are optically heavier on their open side: nudge them toward it.
  const nudge = icon === 'chevron-back' ? -1 : icon === 'chevron-forward' ? 1 : icon === 'play' ? 1.5 : 0;
  const glyph = <Ionicons name={icon} size={Math.round(size * 0.45)} color={color} style={nudge ? { marginLeft: nudge } : undefined} />;
  // Small visual sizes keep a 44 pt hit area.
  const slop = Math.max(8, Math.ceil((44 - size) / 2));
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={slop} scaleTo={0.92}>
      {tone === 'glass' && GLASS ? (
        <GlassView glassEffectStyle="regular" colorScheme="dark" isInteractive style={round}>{glyph}</GlassView>
      ) : tone === 'plain' ? (
        <View style={round}>{glyph}</View>
      ) : (
        <View
          style={[
            round,
            tone === 'glass'
              ? { backgroundColor: C.glass, borderWidth: 1, borderColor: C.glassLine, boxShadow: SHADOW.float }
              : { backgroundColor: C.elevated, borderWidth: 1, borderColor: C.border, boxShadow: SHADOW.inset },
          ]}>
          {glyph}
        </View>
      )}
      {right}
    </Press>
  );
}

export type ButtonVariant = 'solid' | 'soft' | 'ghost' | 'white' | 'glass' | 'plain';

const SKIN: Record<ButtonVariant, { bg: string; border: string; fg: string; shadow?: string }> = {
  /** Primary: accent with a top-lit gradient and a tight drop shadow. */
  solid: { bg: C.accent, border: 'transparent', fg: C.onAccent, shadow: SHADOW.primary },
  /** Secondary on dark surfaces: tinted blue. */
  soft: { bg: C.accentSoft, border: C.accentLine, fg: C.text },
  /** Neutral raised control. */
  ghost: { bg: C.elevated, border: C.border, fg: C.text },
  /** Over key art, maximum contrast. */
  white: { bg: C.white, border: C.white, fg: C.bg, shadow: SHADOW.float },
  /** Secondary over key art: frosted tonal. */
  glass: { bg: C.tonal, border: C.tonalLine, fg: C.white },
  /** Tertiary: text only. */
  plain: { bg: 'transparent', border: 'transparent', fg: C.accentText },
};

/**
 * Actions. `solid` = primary (one per view), `soft` / `ghost` / `glass` = secondary,
 * `plain` = tertiary text. Heights: `small` 44 · default 50 · `large` 56.
 */
export function Button({
  label,
  onPress,
  icon,
  variant = 'solid',
  style,
  small,
  large,
  iconRight,
  disabled,
  loading,
  accessibilityLabel,
  accessibilityHint,
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  variant?: ButtonVariant;
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  large?: boolean;
  iconRight?: boolean;
  disabled?: boolean;
  loading?: boolean;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** @deprecated single accent — ignored */
  color?: string;
  /** @deprecated single accent — ignored */
  textColor?: string;
}) {
  const skin = SKIN[variant];
  const height = small ? H.sm : large ? H.lg : H.md;
  const pressed = useSharedValue(0);
  const shade = useAnimatedStyle(() => ({ opacity: pressed.get() }));
  const inactive = disabled || loading;
  const lit = variant === 'solid' || variant === 'white' || variant === 'glass';
  return (
    <Press
      onPress={inactive ? undefined : onPress}
      haptics={variant === 'solid' ? 'light' : undefined}
      disabled={inactive}
      onPressIn={() => pressed.set(withTiming(1, { duration: DUR.press, easing: ease }))}
      onPressOut={() => pressed.set(withTiming(0, { duration: DUR.release, easing: ease }))}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      style={[
        {
          flexDirection: iconRight ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'center', gap: small ? 6 : S.sm,
          backgroundColor: skin.bg, borderColor: skin.border, borderWidth: variant === 'solid' || variant === 'plain' ? 0 : 1,
          borderRadius: R.control, borderCurve: 'continuous',
          minHeight: height, paddingHorizontal: variant === 'plain' ? S.sm : small ? 14 : 20,
          boxShadow: disabled ? undefined : skin.shadow,
        },
        disabled && { opacity: 0.4 },
        style,
      ]}>
      {variant === 'solid' && (
        <LinearGradient
          pointerEvents="none"
          colors={[C.accentHi, C.accent]}
          style={[StyleSheet.absoluteFill, { borderRadius: R.control, borderCurve: 'continuous' }]}
        />
      )}
      {lit && (
        <View
          pointerEvents="none"
          style={[StyleSheet.absoluteFill, { borderRadius: R.control, borderCurve: 'continuous', boxShadow: variant === 'glass' ? SHADOW.inset : SHADOW.insetStrong }]}
        />
      )}
      {/* Press: darken 12 % on press-in, together with the scale. */}
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, { borderRadius: R.control, borderCurve: 'continuous', backgroundColor: variant === 'white' ? 'rgba(0,0,0,0.1)' : 'rgba(0,0,0,0.16)' }, shade]}
      />
      {loading ? (
        <ActivityIndicator color={skin.fg} />
      ) : (
        <>
          {icon && <Ionicons name={icon} size={small ? 16 : 19} color={skin.fg} style={icon === 'play' ? { marginLeft: 1 } : undefined} />}
          <Text
            numberOfLines={1}
            adjustsFontSizeToFit
            minimumFontScale={0.75}
            maxFontSizeMultiplier={1.4}
            style={{ color: skin.fg, fontSize: small ? 14 : 16, letterSpacing: -0.2, flexShrink: 1, ...F.semibold, ...(variant === 'solid' || variant === 'white' ? F.bold : null), ...TABULAR }}>
            {label}
          </Text>
        </>
      )}
    </Press>
  );
}

/** Vertical icon-over-label action (Netflix "Ma liste" / "Infos"). 44 pt wide minimum. */
export function ActionTile({ icon, label, onPress, active, accessibilityLabel }: { icon: IconName; label: string; onPress: () => void; active?: boolean; accessibilityLabel?: string }) {
  return (
    <Press onPress={onPress} haptics="select" scaleTo={0.92} hitSlop={6} accessibilityRole="button" accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ selected: !!active }} style={styles.tile}>
      <Ionicons name={icon} size={24} color={active ? C.accentText : C.text} />
      <Text maxFontSizeMultiplier={1.3} numberOfLines={1} style={[styles.tileText, active && { color: C.accentText }]}>{label}</Text>
    </Press>
  );
}

// ---------- Tab / screen large title ----------

/** Large title for tab roots ("Anime", "Manhwa"), with optional trailing actions. */
export function ScreenTitle({ title, right }: { title: string; right?: ReactNode }) {
  return (
    <View style={styles.screenTitle}>
      <Txt v="display" numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7} accessibilityRole="header" style={{ flex: 1 }}>{title}</Txt>
      {right}
    </View>
  );
}

// ---------- Section header: sentence-case title, optional "Tout voir ›" ----------

export function SectionHeader({
  title,
  subtitle,
  action,
  onAction,
}: {
  title: string;
  subtitle?: string;
  /** @deprecated headers are text-only now */
  icon?: IconName;
  action?: string;
  onAction?: () => void;
  /** @deprecated */
  accent?: string;
}) {
  return (
    <View style={styles.section}>
      <View style={{ flexShrink: 1, gap: 2 }}>
        <Txt v="section" numberOfLines={1} accessibilityRole="header">{title}</Txt>
        {!!subtitle && <Txt v="footnote" numberOfLines={1}>{subtitle}</Txt>}
      </View>
      {action && (
        <Pressable
          onPress={onAction}
          hitSlop={12}
          accessibilityRole="button"
          accessibilityLabel={`${title}, ${action}`}
          style={({ pressed }) => [{ flexDirection: 'row', alignItems: 'center', gap: 1, minHeight: 32 }, pressed && { opacity: 0.5 }]}>
          <Txt v="small" color={C.text2} style={F.semibold}>{action}</Txt>
          <Ionicons name="chevron-forward" size={14} color={C.text2} />
        </Pressable>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingVertical: 4, paddingHorizontal: 9, borderRadius: R.chip, borderCurve: 'continuous',
    backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine,
  },
  chipText: { ...F.semibold, fontSize: 12, lineHeight: 15, color: C.body, letterSpacing: -0.1 },
  typeBadge: {
    position: 'absolute', left: 6, top: 6, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: 6, borderCurve: 'continuous',
    backgroundColor: 'rgba(5,7,13,0.66)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.10)',
  },
  typeBadgeText: { ...F.semibold, fontSize: 10, color: C.text },
  info: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5, alignSelf: 'flex-start',
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: R.chip, borderCurve: 'continuous',
    backgroundColor: C.pill, borderWidth: 1, borderColor: 'transparent',
  },
  tile: { minWidth: 64, minHeight: 50, alignItems: 'center', justifyContent: 'center', gap: 5 },
  tileText: { ...F.medium, fontSize: 12, color: C.body },
  screenTitle: { flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: S.lg, minHeight: 44 },
  section: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-end', gap: S.md,
    paddingHorizontal: S.lg, paddingTop: 30, paddingBottom: 12,
  },
});
