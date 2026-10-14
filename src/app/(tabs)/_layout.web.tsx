// Web tabs (docs/WEB_DOCKER_PLAN.md §3, "NativeTabs → left rail ≥ 768 px / bottom bar on phones").
// NativeTabs' web rendering is a floating top pill that overlaps the screen headers, so the web
// uses JS tabs:
// · from 768 px, no tab bar here: the shell's left rail and top bar (src/web/shell.tsx, mounted
//   by the root layout so Calendrier / Extensions / Réglages keep them too) do the navigation;
// · on phones, a bottom bar with the native app's five tabs.
import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';

import { useT } from '@/i18n';
import { C, F } from '@/theme/tokens';
import { WIDE, useWindowSize } from '@/web/viewport';

type Icon = ComponentProps<typeof Ionicons>['name'];

const TABS: { name: string; label: 'tabs.home' | 'tabs.anime' | 'tabs.manhwa' | 'tabs.library' | 'tabs.profile'; icon: Icon; active: Icon }[] = [
  { name: 'index', label: 'tabs.home', icon: 'home-outline', active: 'home' },
  { name: 'anime', label: 'tabs.anime', icon: 'tv-outline', active: 'tv' },
  { name: 'manhwa', label: 'tabs.manhwa', icon: 'book-outline', active: 'book' },
  { name: 'library', label: 'tabs.library', icon: 'bookmark-outline', active: 'bookmark' },
  { name: 'profile', label: 'tabs.profile', icon: 'person-circle-outline', active: 'person-circle' },
];

export default function TabsLayout() {
  const t = useT();
  const wide = useWindowSize().width >= WIDE;
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.accentText,
        tabBarInactiveTintColor: C.text2,
        tabBarLabelStyle: { fontSize: 11, ...F.semibold },
        tabBarStyle: wide ? { display: 'none' } : { backgroundColor: 'rgba(12,17,28,0.96)', borderTopColor: C.hairline, height: 60, paddingTop: 4 },
        sceneStyle: { backgroundColor: C.bg },
      }}>
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.label),
            tabBarIcon: ({ focused, color }) => <Ionicons name={focused ? tab.active : tab.icon} color={color} size={23} />,
          }}
        />
      ))}
    </Tabs>
  );
}
