// Local "new episode" notifications for anime in "Ma liste".
// Everything is scheduled on the device from AniList's public airing schedule:
// no push server, no token. Rescheduled on launch, when the list changes and when toggled.
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, Platform } from 'react-native';

import { fetchUpcoming, type UpcomingEpisode } from '@/data/anilist-api';
import { getSeries, useCatalog } from '@/data/catalog';
import { t } from '@/i18n';
import { getSettings, setSetting, useSettings } from '@/settings/settings';
import { useStore } from '@/store/store';

const PREFIX = 'huwa-ep-';
const CHANNEL = 'episodes';
/** iOS keeps at most 64 pending local notifications per app. */
const MAX_SCHEDULED = 60;

export const notificationsSupported = Platform.OS === 'ios' || Platform.OS === 'android';

let configured = false;

export function configureNotifications() {
  if (!notificationsSupported || configured) return;
  configured = true;
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldPlaySound: false,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true,
    }),
  });
  if (Platform.OS === 'android') {
    Notifications.setNotificationChannelAsync(CHANNEL, {
      name: 'Nouveaux épisodes',
      importance: Notifications.AndroidImportance.DEFAULT,
    }).catch(() => {});
  }
}

/** `ask` = show the system prompt if we haven't been answered yet. */
export async function ensurePermission(ask: boolean): Promise<boolean> {
  if (!notificationsSupported) return false;
  configureNotifications();
  const current = await Notifications.getPermissionsAsync();
  if (current.granted || current.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL) return true;
  if (!ask || !current.canAskAgain) return false;
  const res = await Notifications.requestPermissionsAsync();
  return res.granted || res.ios?.status === Notifications.IosAuthorizationStatus.PROVISIONAL;
}

/** AniList anime ids behind "Ma liste" (`al123` series ids). */
function anilistIds(seriesIds: string[]) {
  return seriesIds
    .map((id) => /^al(\d+)$/.exec(id)?.[1])
    .filter((x): x is string => !!x)
    .map(Number);
}

async function cancelOurs() {
  const all = await Notifications.getAllScheduledNotificationsAsync();
  await Promise.all(
    all.filter((n) => n.identifier.startsWith(PREFIX)).map((n) => Notifications.cancelScheduledNotificationAsync(n.identifier)),
  );
}

// Resyncs run one at a time: two overlapping runs (list + setting + catalog changing together)
// used to interleave cancel / schedule and leave duplicates or nothing. A run superseded by a
// newer request while it waited is skipped: only the latest list matters.
let syncChain: Promise<unknown> = Promise.resolve();
let syncGeneration = 0;

/** Replace every episode notification with the current schedule. Returns how many were scheduled. */
export function syncEpisodeNotifications(seriesIds: string[]): Promise<number> {
  const mine = ++syncGeneration;
  const run = syncChain.then(() => (mine === syncGeneration ? doSync(seriesIds, mine) : 0));
  syncChain = run.catch(() => {});
  return run;
}

async function doSync(seriesIds: string[], mine: number): Promise<number> {
  if (!notificationsSupported) return 0;
  configureNotifications();
  await cancelOurs();
  if (!getSettings().notifications || !(await ensurePermission(false))) return 0;

  const ids = anilistIds(seriesIds);
  let upcoming: UpcomingEpisode[];
  try {
    upcoming = await fetchUpcoming(ids);
  } catch {
    // Offline: fall back to the next airing we already know from the catalog.
    upcoming = ids.flatMap((id) => {
      const s = getSeries(`al${id}`);
      return s?.nextAiring ? [{ anilistId: id, title: s.title, ...s.nextAiring }] : [];
    });
  }

  // Superseded while AniList answered (list changed, notifications turned off): the newer run
  // owns the schedule, this one must not put anything back.
  if (mine !== syncGeneration || !getSettings().notifications) return 0;

  const now = Date.now() + 60_000;
  const next = upcoming
    .filter((u) => u.airingAt * 1000 > now)
    .sort((a, b) => a.airingAt - b.airingAt)
    .slice(0, MAX_SCHEDULED);

  for (const u of next) {
    if (mine !== syncGeneration) break;
    const title = getSeries(`al${u.anilistId}`)?.title ?? u.title;
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}${u.anilistId}-${u.episode}`,
      content: {
        title: t('notif.title', { title }),
        body: t('notif.body', { n: u.episode }),
        data: { url: `/anime/al${u.anilistId}` },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(u.airingAt * 1000), channelId: CHANNEL },
    });
  }
  return next.length;
}

/**
 * Turn notifications on from a user gesture (settings switch or contextual prompt).
 * Returns false when the OS refused.
 */
export async function enableNotifications(): Promise<boolean> {
  setSetting('notificationsAsked', true);
  const ok = await ensurePermission(true);
  setSetting('notifications', ok);
  if (!ok) Alert.alert(t('settings.notifications'), t('notif.denied'));
  return ok;
}

/**
 * Mounted once in the root layout:
 *  - asks for permission at the right moment: the first time an airing anime lands in "Ma liste";
 *  - keeps the schedule in sync with the list and the setting;
 *  - opens the series page when a notification is tapped.
 */
export function useEpisodeNotifications() {
  const myList = useStore((s) => s.myList);
  const { notifications, notificationsAsked, lang } = useSettings();
  const catalogVersion = useCatalog();
  const prevList = useRef<string[] | null>(null);

  // Tap → series page.
  useEffect(() => {
    if (!notificationsSupported) return;
    configureNotifications();
    const open = (n: Notifications.Notification) => {
      const url = n.request.content.data?.url;
      if (typeof url === 'string') router.push(url as Href);
    };
    // Cold start from a notification: wait a tick so the root navigator is mounted.
    const coldStart = setTimeout(() => {
      const last = Notifications.getLastNotificationResponse();
      if (last?.notification) {
        open(last.notification);
        Notifications.clearLastNotificationResponse();
      }
    }, 300);
    const sub = Notifications.addNotificationResponseReceivedListener((r) => open(r.notification));
    return () => {
      clearTimeout(coldStart);
      sub.remove();
    };
  }, []);

  // Contextual permission prompt.
  useEffect(() => {
    const prev = prevList.current;
    prevList.current = myList;
    if (!notificationsSupported || notifications || notificationsAsked || !prev) return;
    const added = myList.filter((id) => !prev.includes(id));
    const airing = added.some((id) => getSeries(id)?.nextAiring || getSeries(id)?.status === 'ongoing');
    if (!airing) return;
    setSetting('notificationsAsked', true);
    Alert.alert(t('notif.askTitle'), t('notif.askBody'), [
      { text: t('notif.askNo'), style: 'cancel' },
      { text: t('notif.askYes'), onPress: () => void enableNotifications() },
    ]);
  }, [myList, notifications, notificationsAsked]);

  // Schedule (debounced: list edits come in bursts).
  useEffect(() => {
    if (!notificationsSupported) return;
    void catalogVersion;
    void lang;
    const timer = setTimeout(() => {
      syncEpisodeNotifications(myList).catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [myList, notifications, catalogVersion, lang]);
}
