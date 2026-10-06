// Local "new episode" notifications: anime in "Ma liste" (global setting), series with
// « Me rappeler » on and single episodes with a bell (anime page), see notifications/plan.ts.
// Everything is scheduled on the device from AniList's public airing schedule:
// no push server, no token. Rescheduled on launch, when the list or a bell changes and when toggled.
import * as Notifications from 'expo-notifications';
import { router, type Href } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, Linking, Platform } from 'react-native';

import { fetchUpcoming, type UpcomingEpisode } from '@/data/anilist-api';
import { getEpisode, getSeries, useCatalog } from '@/data/catalog';
import { cachedSchedule, ensureAired, loadUpcoming } from '@/data/upcoming';
import { t } from '@/i18n';
import { getSettings, setSetting, useSettings } from '@/settings/settings';
import { getState, tidyEpisodeReminders, useStore } from '@/store/store';

import { idsToFetch, MAX_SCHEDULED, planNotifications, type PlanSources } from './plan';

const PREFIX = 'huwa-ep-';
const CHANNEL = 'episodes';

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

/** What to notify right now: the store and the global setting. */
const currentSources = (): PlanSources => {
  const st = getState();
  return {
    myList: st.myList,
    listEnabled: getSettings().notifications,
    seriesReminders: st.seriesReminders,
    episodeReminders: st.episodeReminders,
  };
};

/** Replace every episode notification with the current schedule. Returns how many were scheduled. */
export function syncEpisodeNotifications(): Promise<number> {
  const mine = ++syncGeneration;
  const run = syncChain.then(() => (mine === syncGeneration ? doSync(mine) : 0));
  syncChain = run.catch(() => {});
  return run;
}

/** Offline: the cached season schedules (anime page), else the next airing the catalog knows. */
function offlineUpcoming(ids: number[]): UpcomingEpisode[] {
  return ids.flatMap((id) => {
    const s = getSeries(`al${id}`);
    const title = s?.title ?? '';
    const cached = cachedSchedule(`al${id}`)?.nodes;
    if (cached?.length) return cached.map((n) => ({ anilistId: id, title, ...n }));
    return s?.nextAiring ? [{ anilistId: id, title, ...s.nextAiring }] : [];
  });
}

async function doSync(mine: number): Promise<number> {
  if (!notificationsSupported) return 0;
  configureNotifications();
  await cancelOurs();
  await loadUpcoming();
  const ids = idsToFetch(currentSources());
  if (!ids.length || !(await ensurePermission(false))) {
    tidyEpisodeReminders();
    return 0;
  }

  let upcoming: UpcomingEpisode[];
  try {
    upcoming = await fetchUpcoming(ids);
  } catch {
    upcoming = offlineUpcoming(ids);
  }

  // Superseded while AniList answered (list or a bell changed, notifications turned off): the
  // newer run owns the schedule, this one must not put anything back.
  if (mine !== syncGeneration) return 0;
  // Bells follow a postponed episode, and the ones already aired go away.
  tidyEpisodeReminders(upcoming);
  const next = planNotifications(currentSources(), upcoming, { max: MAX_SCHEDULED, titleOf: (id) => getSeries(id)?.title });

  for (const u of next) {
    if (mine !== syncGeneration) break;
    const seriesId = `al${u.anilistId}`;
    const title = getSeries(seriesId)?.title ?? u.title;
    await Notifications.scheduleNotificationAsync({
      identifier: `${PREFIX}${u.anilistId}-${u.episode}`,
      content: {
        title: t('notif.title', { title }),
        body: t('notif.body', { n: u.episode }),
        data: { url: `/anime/${seriesId}`, seriesId, episode: u.episode },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: new Date(u.airingAt * 1000), channelId: CHANNEL },
    });
  }
  return next.length;
}

/**
 * Where a tapped notification leads: the episode it announced (listed now that it aired), else
 * the series page (older notifications only carry `url`).
 */
export function notificationTarget(data: Record<string, unknown> | undefined): Href | undefined {
  const { url, seriesId, episode } = data ?? {};
  if (typeof seriesId === 'string' && typeof episode === 'number') {
    ensureAired(seriesId, episode);
    const ep = getEpisode(`${seriesId}-e${episode}`);
    if (ep) return `/watch/${ep.episode.id}`;
    return `/anime/${seriesId}`;
  }
  return typeof url === 'string' ? (url as Href) : undefined;
}

/**
 * A bell was tapped: true when notifications are allowed (asks the first time). Refused: a
 * short explanation with a way to the system settings.
 */
export async function allowReminders(): Promise<boolean> {
  if (!notificationsSupported) {
    Alert.alert(t('notif.unsupported'));
    return false;
  }
  if (await ensurePermission(true)) return true;
  Alert.alert(t('notif.reminderDeniedTitle'), t('notif.reminderDenied'), [
    { text: t('notif.askNo'), style: 'cancel' },
    { text: t('notif.openSettings'), onPress: () => void Linking.openSettings() },
  ]);
  return false;
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
 *  - restores the cached season schedules (episodes aired since the catalog was fetched);
 *  - asks for permission at the right moment: the first time an airing anime lands in "Ma liste";
 *  - keeps the schedule in sync with the list, the bells and the setting (expired bells dropped);
 *  - opens the announced episode when a notification is tapped.
 */
export function useEpisodeNotifications() {
  const myList = useStore((s) => s.myList);
  const seriesReminders = useStore((s) => s.seriesReminders);
  const episodeReminders = useStore((s) => s.episodeReminders);
  const { notifications, notificationsAsked, lang } = useSettings();
  const catalogVersion = useCatalog();
  const prevList = useRef<string[] | null>(null);

  useEffect(() => {
    void loadUpcoming();
  }, []);

  // Tap → the episode (or the series page).
  useEffect(() => {
    if (!notificationsSupported) return;
    configureNotifications();
    const open = (n: Notifications.Notification) => {
      const href = notificationTarget(n.request.content.data);
      if (href) router.push(href);
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
    void myList;
    void seriesReminders;
    void episodeReminders;
    const timer = setTimeout(() => {
      syncEpisodeNotifications().catch(() => {});
    }, 1500);
    return () => clearTimeout(timer);
  }, [myList, seriesReminders, episodeReminders, notifications, catalogVersion, lang]);
}
