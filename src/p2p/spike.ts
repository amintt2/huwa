// Phase 1 spike checks, run from the app when EXPO_PUBLIC_HUWA_SPIKE=1 (see PLAN.md).
// Output goes to the JS console with a `[spike]` prefix.
import { bareDiagnostics, getP2P, p2pBackend } from './index';

export const SPIKE_WORK = '424242';

export async function runSpike() {
  const log = (...a: unknown[]) => console.log('[spike]', ...a);
  const t0 = Date.now();
  const p2p = getP2P();
  const bare = bareDiagnostics();
  if (!bare) {
    log('backend', p2pBackend(), '-> worklet non démarré');
    return;
  }
  try {
    await bare.ready;
  } catch (err) {
    log('worklet KO', String(err));
    return;
  }
  log('worklet prêt (aller-retour RPC inclus) en', Date.now() - t0, 'ms', 'status', JSON.stringify(p2p.status()));

  const st = await bare.selftest();
  log('hyperbee put/get via RPC', JSON.stringify(st));

  await bare.crashTest();
  await new Promise((r) => setTimeout(r, 1000));
  const after = await bare.selftest();
  log('après erreur volontaire, worklet vivant:', after.ok);

  let me = p2p.me();
  if (!me) {
    const r = await p2p.createIdentity('Simulateur');
    me = r.profile;
    log('identité créée', me.key, me.fingerprint);
  } else {
    log('identité existante', me.key, me.name);
  }

  const seen = new Set<string>();
  p2p.watchComments(SPIKE_WORK, (all) => {
    for (const c of all) {
      if (seen.has(c.id)) continue;
      seen.add(c.id);
      log('commentaire', c.author === me?.key ? 'local' : 'DISTANT', c.authorName, JSON.stringify(c.text), 'latence', Date.now() - c.createdAt, 'ms');
    }
  });
  p2p.onStatus((s) => log('status', JSON.stringify(s)));

  const tp = Date.now();
  const c = await p2p.postComment({ target: `ep:${SPIKE_WORK}-e1`, text: `Bonjour depuis le simulateur ${new Date().toISOString()}`, spoiler: false });
  log('commentaire posté (PoW incluse) en', Date.now() - tp, 'ms', c.id);
}
