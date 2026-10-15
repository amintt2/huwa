// Native app: the Discord invite comes from app.json `expo.extra.discordInvite` (empty = hidden).
// Web: ./invite.web.ts (from /huwa-config.json). See ./discord.ts.
import Constants from 'expo-constants';

import { cleanDiscordInvite } from './discord';

const invite = cleanDiscordInvite(Constants.expoConfig?.extra?.discordInvite);

/** The Discord invite link, or null when none is configured. */
export function useDiscordInvite(): string | null {
  return invite;
}
