/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  activeScope,
  DEFAULT_SETTINGS,
  EMPTY_STATE,
  isSynced,
  resolveSettings,
  sanitizeState,
  setAt,
  setSync,
  settingsAt,
} from '../settings';

const keys = { source: 'asura', title: 'garden' };

test('settings: defaults when nothing is set', () => {
  assert.deepEqual(resolveSettings(EMPTY_STATE, keys), DEFAULT_SETTINGS);
  assert.equal(isSynced(EMPTY_STATE, 'source', keys), true);
  assert.equal(isSynced(EMPTY_STATE, 'title', keys), true);
  assert.equal(activeScope(EMPTY_STATE, keys), 'global');
});

test('settings: title overrides source overrides global', () => {
  let s = setAt(EMPTY_STATE, 'global', keys, { type: 'paged', background: 'gray', separate: true });
  s = setAt(s, 'source', keys, { type: 'vertical', direction: 'rtl' });
  s = setAt(s, 'title', keys, { direction: 'webtoon' });
  const r = resolveSettings(s, keys);
  assert.equal(r.type, 'vertical'); // source
  assert.equal(r.direction, 'webtoon'); // title
  assert.equal(r.background, 'gray'); // global
  assert.equal(r.separate, true);
  // Each scope shows its parent plus its own overrides.
  assert.equal(settingsAt(s, 'global', keys).type, 'paged');
  assert.equal(settingsAt(s, 'source', keys).direction, 'rtl');
  assert.equal(activeScope(s, keys), 'title');
});

test('settings: a synced layer follows its parent, its overrides come back when unsynced', () => {
  let s = setAt(EMPTY_STATE, 'title', keys, { hand: 'left' });
  assert.equal(isSynced(s, 'title', keys), false); // writing detaches
  assert.equal(resolveSettings(s, keys).hand, 'left');
  s = setSync(s, 'title', keys, true);
  assert.equal(resolveSettings(s, keys).hand, 'right');
  s = setAt(s, 'global', keys, { hand: 'left' });
  assert.equal(resolveSettings(s, keys).hand, 'left'); // follows global
  s = setAt(s, 'global', keys, { hand: 'right' });
  s = setSync(s, 'title', keys, false);
  assert.equal(resolveSettings(s, keys).hand, 'left'); // its own value again
});

test('settings: a synced source is skipped, the title still applies', () => {
  let s = setAt(EMPTY_STATE, 'source', keys, { tapToScroll: true });
  s = setSync(s, 'source', keys, true);
  s = setAt(s, 'title', keys, { pageNumber: true });
  const r = resolveSettings(s, keys);
  assert.equal(r.tapToScroll, false);
  assert.equal(r.pageNumber, true);
});

test('settings: other titles and sources are not affected', () => {
  const s = setAt(EMPTY_STATE, 'title', keys, { type: 'paged' });
  assert.equal(resolveSettings(s, { source: 'asura', title: 'void' }).type, 'vertical');
  assert.equal(resolveSettings(s, {}).type, 'vertical');
  // No key: nothing written.
  assert.equal(setAt(EMPTY_STATE, 'title', {}, { type: 'paged' }), EMPTY_STATE);
});

test('settings: persisted junk is dropped, widths are clamped', () => {
  const s = sanitizeState({
    global: { type: 'sideways', widthPortrait: 4, separate: 'yes', unknown: 1, widthLandscape: 0.55 },
    titles: { garden: { sync: false, values: { background: 'white', hand: 3 } }, bad: null },
    sources: 'nope',
  });
  assert.deepEqual(s.global, { widthPortrait: 1, widthLandscape: 0.55 });
  assert.deepEqual(s.titles, { garden: { sync: false, values: { background: 'white' } } });
  assert.deepEqual(s.sources, {});
  assert.equal(setAt(EMPTY_STATE, 'global', keys, { widthPortrait: 0.1 }).global.widthPortrait, 0.3);
});
