// The built-in "Démo Huwa" source (open test streams) only exists so the player works with zero
// setup. Once a real source addon answers for an episode it must step aside: its direct links
// count as "safe" in auto mode (use-source.ts), so they used to win over every real torrent —
// the torrent race never started and the Mux test stream played instead of the episode.

/** Drops `demoBaseUrl` from the stream jobs when another addon is asked for the same episode. */
export function dropDemoWhenReal<J extends { a: { baseUrl: string } }>(jobs: J[], demoBaseUrl: string, resource: string): J[] {
  if (resource !== 'stream') return jobs;
  return jobs.some((j) => j.a.baseUrl !== demoBaseUrl) ? jobs.filter((j) => j.a.baseUrl !== demoBaseUrl) : jobs;
}
