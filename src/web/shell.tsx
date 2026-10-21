// Stremio-Web-like shell (docs/WEB_DOCKER_PLAN.md §1, §3): from 768 px, a left icon rail and a top
// bar with the search field around every page; below, the phone layout (bottom tab bar in
// src/app/(tabs)/_layout.web.tsx). It wraps the root Stack, so Calendrier, Extensions and
// Réglages keep the rail like the tabs do. Full-screen routes (player, reader, onboarding) hide it.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Image } from 'expo-image';
import { router, useGlobalSearchParams, usePathname } from 'expo-router';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { useDiscordInvite } from '@/community/invite';
import { openDiscord } from '@/components/discord-invite';
import { Avatar } from '@/components/social';
import { Txt } from '@/components/ui';
import { useMe } from '@/p2p/hooks';
import { C, F, R, S, SHADOW } from '@/theme/tokens';

import { NAV, isFullScreen, navFor, type NavItem } from './shell-routes';
import { WIDE, setChromeInsets, useWindowSize } from './viewport';

export const RAIL_W = 84;
export const TOP_H = 64;

/** Pressable states on react-native-web (hovered and focused are web-only). */
type WebState = { pressed: boolean; hovered?: boolean; focused?: boolean };

function RailItem({ item, active }: { item: NavItem; active: boolean }) {
  return (
    <Pressable
      onPress={() => router.navigate(item.href)}
      accessibilityRole="link"
      accessibilityLabel={item.label}
      aria-current={active ? 'page' : undefined}
      style={(s) => {
        const st = s as WebState;
        return [styles.railItem, (st.hovered || st.focused) && !active && styles.railItemHover, st.focused && styles.focusRing];
      }}>
      {(s) => {
        const st = s as WebState;
        const lit = active || st.hovered || st.focused;
        return (
          <>
            <View style={[styles.railIcon, active && styles.railIconOn]}>
              <Ionicons name={active ? item.active : item.icon} size={22} color={active ? C.accentText : lit ? C.text : C.text2} />
            </View>
            <Text numberOfLines={1} style={[styles.railLabel, { color: active ? C.text : lit ? C.body : C.text3 }]}>{item.label}</Text>
          </>
        );
      }}
    </Pressable>
  );
}

function Rail({ path }: { path: string }) {
  const current = navFor(path);
  return (
    <View style={styles.rail} role="navigation" aria-label="Navigation principale">
      <Pressable onPress={() => router.navigate('/')} accessibilityRole="link" accessibilityLabel="Huwa, accueil" style={(s) => [styles.logo, (s as WebState).focused && styles.focusRing]}>
        <Image source={{ uri: '/icons/icon-192.png' }} style={{ width: 40, height: 40, borderRadius: 12 }} contentFit="cover" accessibilityIgnoresInvertColors />
      </Pressable>
      <View style={{ gap: 2, paddingTop: S.sm }}>
        {NAV.map((item) => (
          <RailItem key={item.href} item={item} active={current === item.href} />
        ))}
      </View>
    </View>
  );
}

/** Top search field: typing opens /search and keeps its `q` in sync. */
export function SearchField({ compact }: { compact?: boolean }) {
  const path = usePathname();
  const params = useGlobalSearchParams<{ q?: string }>();
  const onSearch = path === '/search';
  const [text, setText] = useState(onSearch ? (params.q ?? '') : '');
  const [focused, setFocused] = useState(false);
  const input = useRef<TextInput>(null);

  // Leaving /search clears the field (state adjusted during render, not in an effect).
  const [wasOnSearch, setWasOnSearch] = useState(onSearch);
  if (wasOnSearch !== onSearch) {
    setWasOnSearch(onSearch);
    if (!onSearch) setText('');
  }

  // "/" focuses the search field, as on Stremio Web and most streaming sites.
  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === '/' && !typing && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  const change = (q: string) => {
    setText(q);
    if (onSearch) router.setParams({ q });
    else router.push({ pathname: '/search', params: { q } });
  };

  return (
    <View style={[styles.search, compact && { height: 40 }, focused && styles.searchFocus]}>
      <Ionicons name="search" size={18} color={focused ? C.text : C.text2} />
      <TextInput
        ref={input}
        value={text}
        onChangeText={change}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onSubmitEditing={() => change(text)}
        placeholder="Rechercher un anime, un manhwa…"
        placeholderTextColor={C.text3}
        selectionColor={C.accentText}
        returnKeyType="search"
        autoCorrect={false}
        accessibilityLabel="Rechercher"
        style={styles.searchInput}
      />
      {!focused && !text && (
        <View style={styles.kbd} aria-hidden>
          <Text style={styles.kbdText}>/</Text>
        </View>
      )}
      {!!text && (
        <Pressable onPress={() => change('')} accessibilityRole="button" accessibilityLabel="Effacer la recherche" hitSlop={8}>
          <Ionicons name="close-circle" size={18} color={C.text2} />
        </Pressable>
      )}
    </View>
  );
}

function AccountButton() {
  const me = useMe();
  return (
    <Pressable
      onPress={() => router.navigate('/profile')}
      accessibilityRole="link"
      accessibilityLabel={me ? `${me.name}, mon profil` : 'Se connecter'}
      style={(s) => {
        const st = s as WebState;
        return [styles.account, me ? null : styles.signIn, st.hovered && styles.accountHover, st.focused && styles.focusRing];
      }}>
      {me ? (
        <>
          <Avatar seed={me.key} name={me.name} size={30} />
          <Txt v="label" numberOfLines={1} style={{ maxWidth: 140 }}>{me.name}</Txt>
        </>
      ) : (
        <>
          <Ionicons name="person-circle-outline" size={20} color={C.text} />
          <Txt v="label">Se connecter</Txt>
        </>
      )}
    </Pressable>
  );
}

/** Top bar shortcut to the community (only when the instance has an invite). */
function DiscordButton() {
  const invite = useDiscordInvite();
  if (!invite) return null;
  return (
    <Pressable
      onPress={() => void openDiscord(invite)}
      accessibilityRole="link"
      accessibilityLabel="Rejoindre le Discord Huwa"
      style={(s) => {
        const st = s as WebState;
        return [styles.discord, st.hovered && styles.discordHover, st.focused && styles.focusRing];
      }}>
      <Ionicons name="logo-discord" size={18} color="#FFFFFF" />
      <Txt v="label" color="#FFFFFF">Discord</Txt>
    </Pressable>
  );
}

function TopBar({ right }: { right?: ReactNode }) {
  return (
    <View style={styles.top} role="banner">
      <View style={{ flex: 1, alignItems: 'center' }}>
        <View style={{ width: '100%', maxWidth: 560 }}>
          <SearchField />
        </View>
      </View>
      <View style={styles.topRight}>
        {right}
        <DiscordButton />
        <AccountButton />
      </View>
    </View>
  );
}

/** Root shell: rail + top bar around the app from 768 px; nothing on phones. */
export function WebShell({ children, right }: { children: ReactNode; right?: ReactNode }) {
  const path = usePathname();
  const me = useMe();
  const { width } = useWindowSize();
  const chrome = width >= WIDE && !isFullScreen(path, !!me);

  useEffect(() => {
    setChromeInsets(chrome ? { left: RAIL_W, top: TOP_H, bottom: 0 } : { left: 0, top: 0, bottom: 0 });
  }, [chrome]);

  if (!chrome) return <View style={{ flex: 1 }}>{children}</View>;
  return (
    <View style={styles.root}>
      <Rail path={path} />
      <View style={{ flex: 1 }}>
        <TopBar right={right} />
        <View style={{ flex: 1, overflow: 'hidden' }}>{children}</View>
      </View>
    </View>
  );
}

const transition = { transitionProperty: 'background-color, color, box-shadow, transform', transitionDuration: '160ms', transitionTimingFunction: 'cubic-bezier(0.23, 1, 0.32, 1)' } as object;

const styles = StyleSheet.create({
  root: { flex: 1, flexDirection: 'row', backgroundColor: C.bg },
  rail: {
    width: RAIL_W, paddingVertical: S.md, alignItems: 'center', backgroundColor: C.bg,
    borderRightWidth: StyleSheet.hairlineWidth, borderRightColor: C.hairline,
  },
  logo: { height: TOP_H - S.md, justifyContent: 'center', alignItems: 'center', borderRadius: 14, paddingHorizontal: 6 },
  railItem: { width: RAIL_W - 12, paddingVertical: 8, alignItems: 'center', gap: 4, borderRadius: R.control, borderCurve: 'continuous', ...transition },
  railItemHover: { backgroundColor: 'rgba(255,255,255,0.05)' },
  railIcon: { width: 44, height: 32, borderRadius: 16, alignItems: 'center', justifyContent: 'center', ...transition },
  railIconOn: { backgroundColor: C.accentSoft },
  railLabel: { fontSize: 11, lineHeight: 13, ...F.semibold, letterSpacing: 0.1 },
  focusRing: { outlineColor: C.accentText, outlineWidth: 2, outlineStyle: 'solid', outlineOffset: 2 } as object,
  top: {
    height: TOP_H, flexDirection: 'row', alignItems: 'center', gap: S.lg, paddingHorizontal: S.xl,
    borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: C.hairline, backgroundColor: C.bg,
  },
  topRight: { flexDirection: 'row', alignItems: 'center', gap: S.sm },
  search: {
    height: 44, flexDirection: 'row', alignItems: 'center', gap: S.sm, paddingHorizontal: 16,
    borderRadius: R.pill, backgroundColor: C.surface, borderWidth: 1, borderColor: C.border,
    boxShadow: 'inset 0px 1px 2px rgba(0,0,0,0.35)', ...transition,
  },
  searchFocus: { borderColor: C.accentLine, backgroundColor: C.elevated },
  searchInput: { flex: 1, color: C.text, fontSize: 15, ...F.medium, paddingVertical: 8, outlineStyle: 'none' } as object,
  kbd: { minWidth: 22, height: 22, borderRadius: 6, borderWidth: 1, borderColor: C.border, alignItems: 'center', justifyContent: 'center' },
  kbdText: { color: C.text3, fontSize: 12, ...F.semibold },
  account: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, height: 44, paddingLeft: 6, paddingRight: 14,
    borderRadius: R.pill, borderWidth: 1, borderColor: 'transparent', ...transition,
  },
  signIn: { paddingLeft: 12, backgroundColor: C.elevated, borderColor: C.border, boxShadow: SHADOW.inset },
  accountHover: { backgroundColor: 'rgba(255,255,255,0.06)' },
  discord: {
    flexDirection: 'row', alignItems: 'center', gap: S.sm, height: 40, paddingHorizontal: 14,
    borderRadius: R.pill, backgroundColor: '#5865F2', boxShadow: SHADOW.insetStrong, ...transition,
  },
  discordHover: { backgroundColor: '#6873F5' },
});
