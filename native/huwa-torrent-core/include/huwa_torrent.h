// C ABI of libhuwa_torrent_core (see src/ffi.rs). All strings are UTF-8, NUL-terminated.
#ifndef HUWA_TORRENT_H
#define HUWA_TORRENT_H

#ifdef __cplusplus
extern "C" {
#endif

/// Static version string ("0.1.0+librqbit-9.0.1"). Do not free.
const char *huwa_torrent_version(void);

/// Starts the engine. `config_json` keys (camelCase): dataDir (required), cacheLimitBytes,
/// seeding, maxPeers, downloadBps, uploadBps, defaultTrackers, resolveTimeoutSecs.
/// Returns a JSON envelope: {"ok":{"port":N,"version":"..."}} or {"error":"..."}.
/// The returned string must be released with huwa_torrent_string_free.
char *huwa_torrent_init(const char *config_json);

/// Generic dispatcher: method in {startStream, status, list, stats, pause, resume, remove,
/// clearCache, enforceQuota, setConfig}; `args_json` may be NULL or "{}".
/// Returns a JSON envelope (see huwa_torrent_init). Blocking: call from a background thread.
char *huwa_torrent_call(const char *method, const char *args_json);

/// Releases a string returned by huwa_torrent_init / huwa_torrent_call. NULL is ignored.
void huwa_torrent_string_free(char *s);

/// Pauses every torrent, persists the session and stops the runtime. Idempotent.
void huwa_torrent_shutdown(void);

#ifdef __cplusplus
}
#endif

#endif /* HUWA_TORRENT_H */
