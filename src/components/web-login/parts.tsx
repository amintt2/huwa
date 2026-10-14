// Shared building blocks of the web login screens: centered column, titles, inline confirmation
// (Alert.alert is a no-op on react-native-web), checkbox, error line.
import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, type ReactNode } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, View, type StyleProp, type ViewStyle } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { DANGER } from '@/components/social';
import { Button, Txt, type IconName } from '@/components/ui';
import { passkeySupport } from '@/p2p/passkey';
import { cancelLogin } from '@/p2p/web/login';
import { C, F, R, S } from '@/theme/tokens';

/** Max width of the login column on a desktop; phones use the full width. */
export const LOGIN_WIDTH = 440;

/** Hosts where the passkey that carries the account can work (D8): the iOS app's RP ID, and dev. */
export function passkeyLoginAvailable(): boolean {
  const host = typeof location !== 'undefined' ? location.hostname : '';
  const allowed = host === 'huwa.mciut.fr' || host === 'localhost' || host === '127.0.0.1' || host.endsWith('.localhost');
  return passkeySupport.available && allowed;
}

export const errorText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/**
 * A login flow that started a node (session.begin) and is left before it produced an account:
 * wipe what it stored. `start()` when the flow begins, `finish()` once it succeeded.
 */
export function useAbandonOnUnmount() {
  const state = useRef({ started: false, finished: false });
  useEffect(() => {
    const s = state.current;
    return () => {
      if (s.started && !s.finished) cancelLogin();
    };
  }, []);
  return {
    start: () => {
      state.current.started = true;
    },
    finish: () => {
      state.current.finished = true;
    },
  };
}

/** Full-height scroll, one centered column (max 440 px). */
export function LoginFrame({ children, onBack, backLabel = 'Retour', center = true }: { children: ReactNode; onBack?: () => void; backLabel?: string; center?: boolean }) {
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: C.bg }}
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={[styles.scroll, { paddingTop: insets.top + S.xl, paddingBottom: insets.bottom + S.xxl }]}>
      <View style={[styles.column, center && { justifyContent: 'center' }]}>
        {onBack ? (
          <Pressable onPress={onBack} accessibilityRole="button" accessibilityLabel={backLabel} hitSlop={8} style={({ pressed }) => [styles.back, pressed && { opacity: 0.6 }]}>
            <Ionicons name="chevron-back" size={18} color={C.accentText} />
            <Txt v="label" color={C.accentText}>{backLabel}</Txt>
          </Pressable>
        ) : null}
        {children}
      </View>
    </ScrollView>
  );
}

export function LoginTitle({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <View style={{ gap: S.sm }}>
      <Txt v="display" accessibilityRole="header" style={{ fontSize: 28, lineHeight: 33 }}>{title}</Txt>
      {subtitle ? <Txt v="body" style={{ fontSize: 16, lineHeight: 23 }}>{subtitle}</Txt> : null}
    </View>
  );
}

/** Raised card used for notices and confirmations. */
export function Card({ children, tone = 'neutral', style }: { children: ReactNode; tone?: 'neutral' | 'accent' | 'danger' | 'warn'; style?: StyleProp<ViewStyle> }) {
  const border = tone === 'accent' ? C.accentLine : tone === 'danger' ? 'rgba(255,107,107,0.45)' : tone === 'warn' ? 'rgba(255,200,87,0.40)' : C.border;
  return <View style={[styles.card, { borderColor: border }, style]}>{children}</View>;
}

/** Destructive primary action (logout, start over). */
export function DangerButton({ label, onPress, loading, disabled, icon }: { label: string; onPress: () => void; loading?: boolean; disabled?: boolean; icon?: IconName }) {
  const inactive = loading || disabled;
  return (
    <Pressable
      onPress={inactive ? undefined : onPress}
      disabled={inactive}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: !!disabled, busy: !!loading }}
      style={({ pressed }) => [styles.danger, pressed && { opacity: 0.85 }, disabled && { opacity: 0.4 }]}>
      {loading ? (
        <ActivityIndicator color={C.white} />
      ) : (
        <>
          {icon ? <Ionicons name={icon} size={18} color={C.white} /> : null}
          <Txt v="label" color={C.white} style={[F.bold, { fontSize: 16 }]}>{label}</Txt>
        </>
      )}
    </Pressable>
  );
}

/** Inline confirmation (title, explanation, confirm + cancel). */
export function ConfirmBox({
  title,
  children,
  confirmLabel,
  onConfirm,
  onCancel,
  busy,
  destructive,
}: {
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  destructive?: boolean;
}) {
  return (
    <Card tone={destructive ? 'danger' : 'accent'}>
      <View accessibilityRole="alert" style={{ gap: S.sm }}>
        <Txt v="headline">{title}</Txt>
        {typeof children === 'string' ? <Txt v="small" style={{ lineHeight: 19 }}>{children}</Txt> : children}
      </View>
      <View style={{ gap: S.sm }}>
        {destructive ? (
          <DangerButton label={confirmLabel} onPress={onConfirm} loading={busy} />
        ) : (
          <Button label={confirmLabel} onPress={onConfirm} loading={busy} />
        )}
        <Button variant="plain" label="Annuler" onPress={onCancel} disabled={busy} />
      </View>
    </Card>
  );
}

export function Checkbox({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <Pressable
      onPress={() => onChange(!checked)}
      accessibilityRole="checkbox"
      accessibilityState={{ checked }}
      accessibilityLabel={label}
      style={({ pressed }) => [styles.check, pressed && { opacity: 0.75 }]}>
      <View style={[styles.box, checked && { backgroundColor: C.accent, borderColor: C.accent }]}>
        {checked ? <Ionicons name="checkmark" size={16} color={C.white} /> : null}
      </View>
      <Txt v="label" style={{ flex: 1 }}>{label}</Txt>
    </Pressable>
  );
}

export function ErrorLine({ text, detail }: { text?: string; detail?: string }) {
  if (!text) return null;
  return (
    <View accessibilityRole="alert" accessibilityLiveRegion="polite" style={{ gap: 2 }}>
      <Txt v="small" color={DANGER} style={{ lineHeight: 18 }}>{text}</Txt>
      {detail ? <Txt v="footnote" color={C.text3} selectable>{`Détail : ${detail}`}</Txt> : null}
    </View>
  );
}

/** Tertiary text action, 44 px tall. */
export function LinkButton({ label, onPress, disabled, color = C.accentText }: { label: string; onPress: () => void; disabled?: boolean; color?: string }) {
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" hitSlop={6} style={({ pressed }) => [styles.link, (pressed || disabled) && { opacity: 0.6 }]}>
      <Txt v="label" color={color} style={[F.semibold, { textAlign: 'center' }]}>{label}</Txt>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  scroll: { flexGrow: 1, alignItems: 'center', paddingHorizontal: S.lg },
  column: { width: '100%', maxWidth: LOGIN_WIDTH, flexGrow: 1, gap: S.xl },
  back: { flexDirection: 'row', alignItems: 'center', gap: 2, alignSelf: 'flex-start', minHeight: 44, paddingRight: S.sm },
  card: { gap: S.md, padding: S.lg, borderRadius: R.card, borderCurve: 'continuous', backgroundColor: C.surface, borderWidth: 1 },
  danger: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: S.sm, minHeight: 50, paddingHorizontal: 20,
    borderRadius: R.control, borderCurve: 'continuous', backgroundColor: '#C9393F',
  },
  check: { flexDirection: 'row', alignItems: 'center', gap: S.md, minHeight: 44 },
  box: {
    width: 24, height: 24, borderRadius: 7, borderWidth: 2, borderColor: C.borderStrong, alignItems: 'center', justifyContent: 'center',
    backgroundColor: C.elevated,
  },
  link: { minHeight: 44, alignItems: 'center', justifyContent: 'center', paddingHorizontal: S.sm },
});
