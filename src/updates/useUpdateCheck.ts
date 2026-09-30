// Vérification d'une mise à jour OTA au lancement, téléchargement silencieux, application à la demande.
//
// Politique : `checkAutomatically: ON_ERROR_RECOVERY` dans app.json laisse le contrôle à ce hook.
// Le natif n'applique jamais une update tout seul au démarrage ; l'utilisateur décide quand redémarrer
// (jamais pendant une lecture). API vérifiée dans expo-updates 57 : `isEnabled`, `checkForUpdateAsync`,
// `fetchUpdateAsync`, `reloadAsync`, `useUpdates`.
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Updates from 'expo-updates';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, InteractionManager } from 'react-native';

import { CHECK_INTERVAL_MS, LAST_CHECK_KEY, OTA_CONFIGURED } from './config';

export type UpdatePhase = 'idle' | 'checking' | 'downloading' | 'ready' | 'error';

export type UpdateState = {
  phase: UpdatePhase;
  /** Une update est téléchargée et n'attend que `apply()`. */
  ready: boolean;
  error?: string;
  /** Version de l'update en attente (champ `extra.expoClient.version` du manifeste si présent). */
  version?: string;
  /** Redémarre sur l'update téléchargée. */
  apply: () => Promise<void>;
  /** Vérification manuelle (Réglages → « Rechercher une mise à jour »). Ignore l'intervalle. */
  checkNow: () => Promise<void>;
};

/** Les updates sont inactives en dev (`expo start`) et sans configuration native. */
export const updatesAvailable = !__DEV__ && Updates.isEnabled && OTA_CONFIGURED;

function versionOf(manifest: unknown): string | undefined {
  const m = manifest as { extra?: { expoClient?: { version?: string } } } | undefined;
  return m?.extra?.expoClient?.version;
}

export function useUpdateCheck(): UpdateState {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [error, setError] = useState<string>();
  const [version, setVersion] = useState<string>();
  const inFlight = useRef(false);

  const run = useCallback(async (force: boolean) => {
    if (!updatesAvailable || inFlight.current) return;
    inFlight.current = true;
    try {
      if (!force) {
        const last = Number(await AsyncStorage.getItem(LAST_CHECK_KEY)) || 0;
        if (Date.now() - last < CHECK_INTERVAL_MS) return;
      }
      setPhase('checking');
      setError(undefined);
      const check = await Updates.checkForUpdateAsync();
      await AsyncStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (!check.isAvailable) {
        setPhase('idle');
        return;
      }
      setPhase('downloading');
      const fetched = await Updates.fetchUpdateAsync();
      if (fetched.isNew) {
        setVersion(versionOf(fetched.manifest));
        setPhase('ready');
      } else {
        setPhase('idle');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('error');
    } finally {
      inFlight.current = false;
    }
  }, []);

  // Au lancement (après les interactions initiales, pour ne pas concurrencer le splash),
  // puis à chaque retour au premier plan (l'intervalle borne la fréquence).
  useEffect(() => {
    const task = InteractionManager.runAfterInteractions(() => {
      run(false);
    });
    const sub = AppState.addEventListener('change', (s) => {
      if (s === 'active') run(false);
    });
    return () => {
      task.cancel();
      sub.remove();
    };
  }, [run]);

  const apply = useCallback(async () => {
    if (phase !== 'ready') return;
    await Updates.reloadAsync();
  }, [phase]);

  return { phase, ready: phase === 'ready', error, version, apply, checkNow: () => run(true) };
}
