// Why an episode has nothing to play, in plain French, with the one action that fixes it
// (pure, unit-tested). Shown by the watch screen instead of a generic "no source" message.

export type NoSourceInput = {
  /** Addons asked for this episode (stream resource). */
  asked: number;
  /** Addons still answering. */
  pending: number;
  /** A source is being picked / links are being measured. */
  deciding: boolean;
  /** Video rows received (status rows excluded). */
  streams: number;
  /** Names of the addons that failed (timeout, error). */
  failed: string[];
  /** Torrents among the streams. */
  torrents: number;
  /** A debrid service or the on-device engine can play torrents. */
  canResolveTorrents: boolean;
  /** The on-device torrent engine exists in this build (just switched off). */
  engineAvailable: boolean;
  /** Direct links / torrents that could be played here (before failures). */
  playable: number;
  /** Of those, the ones that failed in the player or proved dead in the race. */
  dead: number;
};

export type NoSourceKind = 'no-addon' | 'addons-failed' | 'nothing-found' | 'torrents-only' | 'all-dead' | 'unsupported';
export type NoSourceAction = 'addons' | 'retry' | 'enable-engine' | 'debrid' | 'sources';

export type NoSource = { kind: NoSourceKind; title: string; message: string; action?: { kind: NoSourceAction; label: string } };

const list = (names: string[]) => (names.length > 2 ? `${names.slice(0, 2).join(', ')}…` : names.join(' et '));

/** null while still searching, or when something can play. */
export function classifyNoSource(x: NoSourceInput): NoSource | null {
  if (x.pending > 0 || x.deciding) return null;
  if (x.asked === 0) {
    return {
      kind: 'no-addon',
      title: 'Aucun addon de sources',
      message: 'Huwa ne fournit pas de vidéos : installe un addon de sources (Stremio) pour regarder cet épisode.',
      action: { kind: 'addons', label: 'Ajouter un addon' },
    };
  }
  if (x.streams === 0) {
    if (x.failed.length >= x.asked) {
      return {
        kind: 'addons-failed',
        title: 'Les addons ne répondent pas',
        message: `${list(x.failed)} ${x.failed.length > 1 ? 'n’ont' : 'n’a'} pas répondu (réseau ou serveur indisponible).`,
        action: { kind: 'retry', label: 'Réessayer' },
      };
    }
    return {
      kind: 'nothing-found',
      title: 'Rien trouvé pour cet épisode',
      message: x.failed.length
        ? `Tes addons n’ont aucune vidéo pour cet épisode, et ${list(x.failed)} n’a pas répondu.`
        : 'Tes addons n’ont aucune vidéo pour cet épisode. Un autre addon en aura peut-être.',
      action: x.failed.length ? { kind: 'retry', label: 'Réessayer' } : { kind: 'addons', label: 'Ajouter un addon' },
    };
  }
  if (x.torrents > 0 && !x.canResolveTorrents && x.playable === 0) {
    return x.engineAvailable
      ? {
          kind: 'torrents-only',
          title: 'Seulement des torrents',
          message: 'Les sources trouvées sont des torrents. Active le moteur torrent intégré pour les lire.',
          action: { kind: 'enable-engine', label: 'Activer le moteur torrent' },
        }
      : {
          kind: 'torrents-only',
          title: 'Seulement des torrents',
          message: 'Les sources trouvées sont des torrents. Ajoute un service débrid pour les lire.',
          action: { kind: 'debrid', label: 'Configurer un débrid' },
        };
  }
  if (x.playable > 0 && x.dead >= x.playable) {
    return {
      kind: 'all-dead',
      title: 'Tous les liens sont morts',
      message: `${x.playable > 1 ? `Les ${x.playable} liens trouvés ne répondent` : 'Le lien trouvé ne répond'} plus. Une nouvelle recherche en trouvera peut-être d’autres.`,
      action: { kind: 'retry', label: 'Chercher à nouveau' },
    };
  }
  if (x.playable === 0) {
    return {
      kind: 'unsupported',
      title: 'Sources non lisibles ici',
      message: 'Les sources trouvées s’ouvrent hors de Huwa (page web, YouTube…). Ouvre le menu des sources.',
      action: { kind: 'sources', label: 'Voir les sources' },
    };
  }
  return null;
}
