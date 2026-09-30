import { NativeTabs } from 'expo-router/unstable-native-tabs';

import { C } from '@/theme/tokens';

/**
 * Native UITabBar: real Liquid Glass on iOS 26+, shrinks while scrolling down,
 * Material bottom navigation on Android. Tabs are peers — no custom transitions.
 */
export default function TabsLayout() {
  return (
    <NativeTabs
      minimizeBehavior="onScrollDown"
      tintColor={C.accentText}
      iconColor={{ default: C.text2, selected: C.accentText }}
      labelStyle={{ default: { color: C.text2 }, selected: { color: C.text } }}
      backgroundColor={C.surface}
      indicatorColor={C.accentSoft}>
      <NativeTabs.Trigger name="index">
        <NativeTabs.Trigger.Label>Accueil</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'house', selected: 'house.fill' }} md="home" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="anime">
        <NativeTabs.Trigger.Label>Anime</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'play.tv', selected: 'play.tv.fill' }} md="live_tv" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="manhwa">
        <NativeTabs.Trigger.Label>Manhwa</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'book', selected: 'book.fill' }} md="menu_book" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="library">
        <NativeTabs.Trigger.Label>Biblio</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'bookmark', selected: 'bookmark.fill' }} md="bookmarks" />
      </NativeTabs.Trigger>
      <NativeTabs.Trigger name="profile">
        <NativeTabs.Trigger.Label>Profil</NativeTabs.Trigger.Label>
        <NativeTabs.Trigger.Icon sf={{ default: 'person.crop.circle', selected: 'person.crop.circle.fill' }} md="account_circle" />
      </NativeTabs.Trigger>
    </NativeTabs>
  );
}
