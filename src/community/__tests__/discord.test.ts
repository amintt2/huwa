import assert from 'node:assert/strict';
import { test } from 'node:test';

import AsyncStorage from '@react-native-async-storage/async-storage';

import { parseConfig } from '../../web/config';
import { cleanDiscordInvite, finishDiscordInvite, inviteState, loadInviteState, parseInviteState, requestDiscordInvite, resetInviteForTests } from '../discord';

const KEY = 'huwa/community/discord-invite/v1';

test('cleanDiscordInvite: https Discord invites only', () => {
  assert.equal(cleanDiscordInvite('https://discord.gg/abcDEF'), 'https://discord.gg/abcDEF');
  assert.equal(cleanDiscordInvite(' https://discord.com/invite/abc '), 'https://discord.com/invite/abc');
  assert.equal(cleanDiscordInvite('https://discord.gg/'), null);
  assert.equal(cleanDiscordInvite('http://discord.gg/abc'), null);
  assert.equal(cleanDiscordInvite('https://discord.gg.evil.example/abc'), null);
  assert.equal(cleanDiscordInvite('https://evil.example/discord.gg/abc'), null);
  assert.equal(cleanDiscordInvite('javascript:alert(1)'), null);
  assert.equal(cleanDiscordInvite(''), null);
  assert.equal(cleanDiscordInvite(undefined), null);
});

test('/huwa-config.json community.discord', () => {
  assert.equal(parseConfig({ v: 1 }).community.discord, null);
  assert.equal(parseConfig({ community: { discord: 'https://discord.gg/huwa' } }).community.discord, 'https://discord.gg/huwa');
  assert.equal(parseConfig({ community: { discord: 'https://example.org' } }).community.discord, null);
});

test('the invitation is shown once: pending after onboarding, done for good', async () => {
  await AsyncStorage.removeItem(KEY);
  resetInviteForTests();
  await loadInviteState();
  assert.equal(inviteState(), 'none');
  await requestDiscordInvite();
  assert.equal(inviteState(), 'pending');
  assert.equal(await AsyncStorage.getItem(KEY), 'pending');
  finishDiscordInvite();
  assert.equal(inviteState(), 'done');
  // Another account later (restore on the same device): no second invitation.
  await requestDiscordInvite();
  assert.equal(inviteState(), 'done');
  // Survives a restart.
  resetInviteForTests();
  await loadInviteState();
  assert.equal(inviteState(), 'done');
  assert.equal(parseInviteState('garbage'), 'none');
});

test('a pending invitation survives a restart (app killed before it showed)', async () => {
  await AsyncStorage.setItem(KEY, 'pending');
  resetInviteForTests();
  await loadInviteState();
  assert.equal(inviteState(), 'pending');
  finishDiscordInvite();
});
