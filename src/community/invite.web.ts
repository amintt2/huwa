// Web: the Discord invite comes from the instance, `/huwa-config.json` → `community.discord`
// (huwa-server: HUWA_DISCORD_INVITE). Native: ./invite.ts. See ./discord.ts.
import { useWebConfig } from '@/web/config';

/** The Discord invite link, or null when the instance has none. */
export function useDiscordInvite(): string | null {
  return useWebConfig().community.discord;
}
