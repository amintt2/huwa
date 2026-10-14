import Ionicons from '@expo/vector-icons/Ionicons';
import { Tabs } from 'expo-router';
import type { ComponentProps } from 'react';

import { useT } from '@/i18n';
import { C } from '@/theme/tokens';

type Icon = ComponentProps<typeof Ionicons>['name'];

const TABS: { name: string; label: 'tabs.home' | 'tabs.anime' | 'tabs.manhwa' | 'tabs.library' | 'tabs.profile'; icon: Icon; active: Icon }[] = [
  { name: 'index', label: 'tabs.home', icon: 'home-outline', active: 'home' },
  { name: 'anime', label: 'tabs.anime', icon: 'tv-outline', active: 'tv' },
  { name: 'manhwa', label: 'tabs.manhwa', icon: 'book-outline', active: 'book' },
  { name: 'library', label: 'tabs.library', icon: 'bookmark-outline', active: 'bookmark' },
  { name: 'profile', label: 'tabs.profile', icon: 'person-circle-outline', active: 'person-circle' },
];

/**
 * Web placeholder for the NativeTabs bar (whose web rendering is a floating top pill that
 * overlaps the screen headers on phones): a plain JS bottom tab bar. Phase 1 replaces it with the
 * Stremio-like left rail ≥768 px / bottom bar on phones (docs/WEB_DOCKER_PLAN.md §3).
 */
export default function TabsLayout() {
  const t = useT();
  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarActiveTintColor: C.accentText,
        tabBarInactiveTintColor: C.text2,
        tabBarStyle: { backgroundColor: C.surface, borderTopColor: C.border },
        sceneStyle: { backgroundColor: C.bg },
      }}>
      {TABS.map((tab) => (
        <Tabs.Screen
          key={tab.name}
          name={tab.name}
          options={{
            title: t(tab.label),
            tabBarIcon: ({ focused, color, size }) => <Ionicons name={focused ? tab.active : tab.icon} color={color} size={size} />,
          }}
        />
      ))}
    </Tabs>
  );
}
