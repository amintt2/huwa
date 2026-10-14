import assert from 'node:assert/strict';
import { test } from 'node:test';

import { isFullScreen, navFor } from '../shell-routes';

test('rail item of a path', () => {
  assert.equal(navFor('/'), '/');
  assert.equal(navFor('/anime'), '/anime');
  assert.equal(navFor('/anime/al123'), '/anime');
  assert.equal(navFor('/manhwa/al9'), '/manhwa');
  assert.equal(navFor('/lists'), '/library');
  assert.equal(navFor('/addon-catalog'), '/addons');
  assert.equal(navFor('/extension'), '/addons');
  assert.equal(navFor('/settings/general'), '/settings');
  assert.equal(navFor('/search'), null);
  assert.equal(navFor('/watch/x'), null);
});

test('full-screen routes hide the shell (player and reader only once signed in)', () => {
  assert.equal(isFullScreen('/watch/al1-e1', true), true);
  assert.equal(isFullScreen('/watch/al1-e1', false), false);
  assert.equal(isFullScreen('/read/c1', true), true);
  assert.equal(isFullScreen('/onboarding/restore', false), true);
  assert.equal(isFullScreen('/anime/al1', true), false);
});
