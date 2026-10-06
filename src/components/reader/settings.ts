// Reader settings, Paperback-style scopes (pure, no I/O: tested in __tests__).
//
// Three layers: Global → Source (the extension a series is read from) → Titre (one series).
// A Source / Titre layer either follows its parent ("Synchroniser avec le parent", the default)
// or overrides some values. Resolution: defaults ← global ← source (unless synced) ← title
// (unless synced). Overrides are partial: a value never touched keeps following the parent.

export type ReaderType = 'vertical' | 'paged';
/** Paged mode only: right-to-left (manga), left-to-right, or vertical pages (webtoon). */
export type ReaderDirection = 'rtl' | 'ltr' | 'webtoon';
export type ReaderBackground = 'theme' | 'black' | 'white' | 'gray';
export type Handedness = 'right' | 'left';

export type ReaderSettings = {
  type: ReaderType;
  direction: ReaderDirection;
  /** Maximum page width, as a fraction of the screen width (0.3‒1). */
  widthPortrait: number;
  widthLandscape: number;
  /** Spacing between pages. */
  separate: boolean;
  /** Decode large pages at display size (lower memory). */
  downsample: boolean;
  background: ReaderBackground;
  hand: Handedness;
  /** Hide the status bar and the home indicator while the overlay is hidden. */
  hideBars: boolean;
  /** Tap the sides to scroll / turn the page. */
  tapToScroll: boolean;
  /** Hide the overlay as soon as the reader is scrolled. */
  autoHide: boolean;
  /** Keep a small page number visible when the overlay is hidden. */
  pageNumber: boolean;
  /** Lock the reader in its current orientation (otherwise it follows the device). */
  orientationLock: boolean;
  keepAwake: boolean;
};

export const DEFAULT_SETTINGS: ReaderSettings = {
  type: 'vertical',
  direction: 'ltr',
  widthPortrait: 1,
  widthLandscape: 0.7,
  separate: false,
  downsample: true,
  background: 'black',
  hand: 'right',
  hideBars: true,
  tapToScroll: false,
  autoHide: true,
  pageNumber: false,
  orientationLock: true,
  keepAwake: true,
};

export type Scope = 'global' | 'source' | 'title';
export type ScopeLayer = { sync: boolean; values: Partial<ReaderSettings> };
export type SettingsState = {
  global: Partial<ReaderSettings>;
  sources: Record<string, ScopeLayer>;
  titles: Record<string, ScopeLayer>;
};

export const EMPTY_STATE: SettingsState = { global: {}, sources: {}, titles: {} };
/** Where the reader is: the source key and the series id (either may be unknown). */
export type ScopeKeys = { source?: string; title?: string };

const ENUMS: { [K in keyof ReaderSettings]?: readonly string[] } = {
  type: ['vertical', 'paged'],
  direction: ['rtl', 'ltr', 'webtoon'],
  background: ['theme', 'black', 'white', 'gray'],
  hand: ['right', 'left'],
};

export const clampWidth = (v: number) => Math.round(Math.min(1, Math.max(0.3, v)) * 100) / 100;

/** Keeps only known keys with valid values (persisted data may be old or damaged). */
export function sanitize(raw: unknown): Partial<ReaderSettings> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    const def = DEFAULT_SETTINGS[k as keyof ReaderSettings];
    const allowed = ENUMS[k as keyof ReaderSettings];
    if (allowed) {
      if (typeof v === 'string' && allowed.includes(v)) out[k] = v;
    } else if (typeof def === 'number') {
      if (typeof v === 'number' && Number.isFinite(v)) out[k] = clampWidth(v);
    } else if (typeof v === typeof def) out[k] = v;
  }
  return out as Partial<ReaderSettings>;
}

function sanitizeLayers(raw: unknown): Record<string, ScopeLayer> {
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ScopeLayer> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const l = v as Partial<ScopeLayer> | null;
    if (!l || typeof l !== 'object') continue;
    out[k] = { sync: l.sync !== false, values: sanitize(l.values) };
  }
  return out;
}

export function sanitizeState(raw: unknown): SettingsState {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<SettingsState>;
  return { global: sanitize(r.global), sources: sanitizeLayers(r.sources), titles: sanitizeLayers(r.titles) };
}

const layerOf = (state: SettingsState, scope: Exclude<Scope, 'global'>, key?: string): ScopeLayer | undefined =>
  key === undefined ? undefined : (scope === 'source' ? state.sources : state.titles)[key];

/** Settings as seen at a scope: the parent's values plus this scope's overrides (unless synced). */
export function settingsAt(state: SettingsState, scope: Scope, keys: ScopeKeys): ReaderSettings {
  let s: ReaderSettings = { ...DEFAULT_SETTINGS, ...state.global };
  if (scope === 'global') return s;
  const src = layerOf(state, 'source', keys.source);
  if (src && !src.sync) s = { ...s, ...src.values };
  if (scope === 'source') return s;
  const title = layerOf(state, 'title', keys.title);
  if (title && !title.sync) s = { ...s, ...title.values };
  return s;
}

/** Effective settings of the reader. */
export const resolveSettings = (state: SettingsState, keys: ScopeKeys) => settingsAt(state, 'title', keys);

/** Whether a Source / Titre layer follows its parent (always false for Global). */
export function isSynced(state: SettingsState, scope: Scope, keys: ScopeKeys): boolean {
  if (scope === 'global') return false;
  return layerOf(state, scope, scope === 'source' ? keys.source : keys.title)?.sync ?? true;
}

/** The most specific layer that is not synced: where quick toggles in the reader write. */
export function activeScope(state: SettingsState, keys: ScopeKeys): Scope {
  if (keys.title !== undefined && !isSynced(state, 'title', keys)) return 'title';
  if (keys.source !== undefined && !isSynced(state, 'source', keys)) return 'source';
  return 'global';
}

function withLayer(state: SettingsState, scope: Exclude<Scope, 'global'>, key: string, fn: (l: ScopeLayer) => ScopeLayer): SettingsState {
  const field = scope === 'source' ? 'sources' : 'titles';
  const prev = state[field][key] ?? { sync: true, values: {} };
  return { ...state, [field]: { ...state[field], [key]: fn(prev) } };
}

/** Writes values at a scope. Writing to a synced layer detaches it from its parent. */
export function setAt(state: SettingsState, scope: Scope, keys: ScopeKeys, patch: Partial<ReaderSettings>): SettingsState {
  const clean = sanitize(patch);
  if (scope === 'global') return { ...state, global: { ...state.global, ...clean } };
  const key = scope === 'source' ? keys.source : keys.title;
  if (key === undefined) return state;
  return withLayer(state, scope, key, (l) => ({ sync: false, values: { ...l.values, ...clean } }));
}

/**
 * Follow the parent again (overrides are kept, so switching it off restores them), or stop
 * following it (starts from the parent's values: nothing changes until something is edited).
 */
export function setSync(state: SettingsState, scope: Exclude<Scope, 'global'>, keys: ScopeKeys, sync: boolean): SettingsState {
  const key = scope === 'source' ? keys.source : keys.title;
  if (key === undefined) return state;
  return withLayer(state, scope, key, (l) => ({ ...l, sync }));
}
