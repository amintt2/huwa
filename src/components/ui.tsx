import Ionicons from '@expo/vector-icons/Ionicons';
import { GlassView, isLiquidGlassAvailable } from 'expo-glass-effect';
import { Image } from 'expo-image';
import { LinearGradient } from 'expo-linear-gradient';
import type { ComponentProps, ReactNode } from 'react';
import {
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
import { C, EASE_OUT, F, R, S, kindIcon, kindLabel, type Kind } from '@/theme/tokens';

export type IconName = ComponentProps<typeof Ionicons>['name'];

const ease = Easing.bezier(...EASE_OUT);
const GLASS = isLiquidGlassAvailable();

// ---------- Text ----------

const variants = {
  /** Screen / hero titles — heavy uppercase, the one display size per screen. */
  display: { ...F.black, fontSize: 30, letterSpacing: 0.2, textTransform: 'uppercase', color: C.text },
  title: { ...F.heavy, fontSize: 22, letterSpacing: 0.2, color: C.text },
  section: { ...F.black, fontSize: 18, letterSpacing: 0.4, textTransform: 'uppercase', color: C.text },
  body: { ...F.regular, fontSize: 15, lineHeight: 21, color: C.text2 },
  label: { ...F.semibold, fontSize: 15, color: C.text },
  small: { ...F.medium, fontSize: 13, color: C.text2 },
  caption: { ...F.bold, fontSize: 11, letterSpacing: 0.6, textTransform: 'uppercase', color: C.text2 },
} as const;

/**
 * Heavy uppercase titles grow with Dynamic Type only so far: at the largest sizes a single word
 * ("BIBLIOTHÈQUE") no longer fit the width and iOS broke it mid-word. Body text is not capped.
 */
const MAX_SCALE: Partial<Record<keyof typeof variants, number>> = { display: 1.3, section: 1.5, title: 1.6 };

export function Txt({
  v = 'body',
  color,
  style,
  ...rest
}: TextProps & { v?: keyof typeof variants; color?: string }) {
  return <Text maxFontSizeMultiplier={MAX_SCALE[v]} {...rest} style={[variants[v], color ? { color } : null, style]} />;
}

// ---------- Press feedback: scale 0.97 on press-in (120 ms), back in 160 ms ----------

const APressable = Animated.createAnimatedComponent(Pressable);

export function Press({
  style,
  onPressIn,
  onPressOut,
  scaleTo = 0.97,
  ...rest
}: PressableProps & { style?: StyleProp<ViewStyle>; scaleTo?: number }) {
  const scale = useSharedValue(1);
  const anim = useAnimatedStyle(() => ({ transform: [{ scale: scale.get() }] }));
  return (
    <APressable
      {...rest}
      onPressIn={(e) => {
        scale.set(withTiming(scaleTo, { duration: 120, easing: ease }));
        onPressIn?.(e);
      }}
      onPressOut={(e) => {
        scale.set(withTiming(1, { duration: 160, easing: ease }));
        onPressOut?.(e);
      }}
      style={[style, anim]}
    />
  );
}

// ---------- Tags & badges ----------

/** Bordered uppercase tag (genres, type, status). `accent` / `bridge` = tinted blue. */
export function Chip({ kind, label }: { kind: Kind | 'neutral' | 'bridge' | 'accent'; label?: string }) {
  const text = label ?? (kind === 'anime' || kind === 'manhwa' ? kindLabel(kind) : '');
  const tinted = kind === 'bridge' || kind === 'accent';
  return (
    <View style={[styles.chip, tinted && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      {kind === 'bridge' && <Ionicons name="swap-horizontal" size={11} color={C.accentText} />}
      <Txt v="caption" color={tinted ? C.accentText : C.body} style={{ fontSize: 10 }}>{text}</Txt>
    </View>
  );
}

/** Small badge pinned on a poster corner ("Anime", "Manhwa"). */
export function TypeBadge({ kind, style }: { kind: Kind; style?: StyleProp<ViewStyle> }) {
  return (
    <View style={[styles.typeBadge, style]}>
      <Ionicons name={kindIcon(kind)} size={10} color={C.text} />
      <Txt v="caption" color={C.text} style={{ fontSize: 9 }}>{kind === 'anime' ? 'Anime' : 'Manhwa'}</Txt>
    </View>
  );
}

/** Info pill with icon: "Épisode 14", "15:04", "Chapitre 142". */
export function InfoPill({ icon, label, tone = 'neutral' }: { icon: IconName; label: string; tone?: 'neutral' | 'accent' }) {
  const accent = tone === 'accent';
  return (
    <View style={[styles.info, accent && { backgroundColor: C.accentSoft, borderColor: C.accentLine }]}>
      <Ionicons name={icon} size={12} color={accent ? C.accentText : C.text2} />
      <Txt v="small" color={accent ? C.accentText : C.body} style={{ fontSize: 11, ...F.semibold }} numberOfLines={1}>
        {label}
      </Txt>
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
  radius = R.card,
  shade,
  dim,
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
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, { borderRadius: radius, borderCurve: 'continuous', borderWidth: 1, borderColor: 'rgba(255,255,255,0.1)' }]} />
      {children}
    </View>
  );
}

// ---------- Progress ----------

export function Progress({ value, color = C.accentText, track = C.elevated, height = 3 }: { value: number; color?: string; track?: string; height?: number }) {
  return (
    <View style={{ height, backgroundColor: track, borderRadius: height, overflow: 'hidden' }}>
      <View style={{ width: `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`, height, backgroundColor: color }} />
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
}: {
  icon: IconName;
  onPress?: () => void;
  size?: number;
  tone?: 'glass' | 'solid';
  color?: string;
  label: string;
}) {
  const round = { width: size, height: size, borderRadius: size / 2, alignItems: 'center', justifyContent: 'center' } as const;
  const glyph = <Ionicons name={icon} size={size * 0.46} color={color} />;
  return (
    <Press onPress={onPress} accessibilityRole="button" accessibilityLabel={label} hitSlop={8} scaleTo={0.94}>
      {tone === 'glass' && GLASS ? (
        <GlassView glassEffectStyle="regular" colorScheme="dark" isInteractive style={round}>{glyph}</GlassView>
      ) : (
        <View style={[round, { backgroundColor: tone === 'glass' ? 'rgba(5,7,13,0.55)' : C.elevated, borderWidth: 1, borderColor: C.border }]}>
          {glyph}
        </View>
      )}
    </Press>
  );
}

/**
 * Actions: `solid` = the primary accent, `soft` = translucent blue with a hairline border,
 * `ghost` = neutral surface, `white` = over key art.
 */
export function Button({
  label,
  onPress,
  icon,
  variant = 'solid',
  style,
  small,
  iconRight,
}: {
  label: string;
  onPress?: () => void;
  icon?: IconName;
  variant?: 'solid' | 'soft' | 'ghost' | 'white';
  style?: StyleProp<ViewStyle>;
  small?: boolean;
  iconRight?: boolean;
  /** @deprecated single accent — ignored */
  color?: string;
  /** @deprecated single accent — ignored */
  textColor?: string;
}) {
  const skin = {
    solid: { backgroundColor: C.accent, borderColor: 'rgba(255,255,255,0.12)', fg: C.onAccent },
    soft: { backgroundColor: C.accentSoft, borderColor: C.accentLine, fg: C.white },
    ghost: { backgroundColor: C.elevated, borderColor: C.border, fg: C.text },
    white: { backgroundColor: C.white, borderColor: C.white, fg: C.bg },
  }[variant];
  return (
    <Press
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[
        {
          flexDirection: iconRight ? 'row-reverse' : 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm,
          backgroundColor: skin.backgroundColor, borderColor: skin.borderColor, borderWidth: 1,
          borderRadius: R.control, borderCurve: 'continuous',
          minHeight: small ? 38 : 50, paddingHorizontal: small ? 14 : 18,
        },
        style,
      ]}>
      {icon && <Ionicons name={icon} size={small ? 14 : 16} color={skin.fg} />}
      <Txt v="caption" color={skin.fg} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.75}
        style={{ fontSize: small ? 12 : 13, letterSpacing: 0.8, flexShrink: 1, ...F.heavy }}>{label}</Txt>
    </Press>
  );
}

// ---------- Section header: icon + heavy uppercase title + rule underneath ----------

export function SectionHeader({
  title,
  icon,
  action,
  onAction,
}: {
  title: string;
  icon?: IconName;
  action?: string;
  onAction?: () => void;
  /** @deprecated */
  accent?: string;
}) {
  return (
    <View style={styles.section}>
      <View style={styles.sectionRow}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: S.sm, flexShrink: 1 }}>
          {icon && <Ionicons name={icon} size={18} color={C.text} />}
          <Txt v="section" numberOfLines={1} style={{ flexShrink: 1 }}>{title}</Txt>
        </View>
        {action && (
          <Pressable onPress={onAction} hitSlop={12} style={{ flexDirection: 'row', alignItems: 'center', gap: 2 }}>
            <Txt v="small" color={C.accentText} style={F.semibold}>{action}</Txt>
            <Ionicons name="chevron-forward" size={14} color={C.accentText} />
          </Pressable>
        )}
      </View>
      <View style={styles.rule} />
    </View>
  );
}

const styles = StyleSheet.create({
  chip: {
    flexDirection: 'row', alignItems: 'center', gap: 4, alignSelf: 'flex-start',
    paddingVertical: 4, paddingHorizontal: 8, borderRadius: R.chip, borderCurve: 'continuous',
    backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine,
  },
  typeBadge: {
    position: 'absolute', left: 8, top: 8, flexDirection: 'row', alignItems: 'center', gap: 4,
    paddingVertical: 3, paddingHorizontal: 6, borderRadius: R.chip, borderCurve: 'continuous',
    backgroundColor: 'rgba(5,7,13,0.72)', borderWidth: 1, borderColor: 'rgba(255,255,255,0.12)',
  },
  info: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 5,
    paddingVertical: 5, paddingHorizontal: 8, borderRadius: R.chip, borderCurve: 'continuous',
    backgroundColor: C.pill, borderWidth: 1, borderColor: C.pillLine,
  },
  section: { paddingHorizontal: S.lg, paddingTop: 28, paddingBottom: 14, gap: 10 },
  sectionRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: S.md },
  rule: { height: 2, borderRadius: 1, backgroundColor: 'rgba(120,140,180,0.22)' },
});
