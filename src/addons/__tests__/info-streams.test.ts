/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { infoKind, type StreamItem } from '../protocol';
import { autoWebPlayerUrl } from '../web-player';

// Shapes returned by an AIOStreams instance (2026-10).
const GH = 'https://github.com/Viren070/AIOStreams';
const summary = { name: '🟢 [Meteor p2p] Scrape Summary', description: '✔ Status : SUCCESS\n📦 Streams : 13', externalUrl: GH, streamData: { type: 'statistic' } } as StreamItem;
const partial = { name: '🟠 [EZTV RD] Scrape Summary', description: '✔ Status : PARTIAL SUCCESS', externalUrl: GH, streamData: { type: 'statistic' } } as StreamItem;
const error = { name: '❌ No debrid services', description: 'No debrid services are configured.', externalUrl: GH, streamData: { type: 'error' } } as StreamItem;
const promo = { name: '💩 Unknown', description: '🎬 Support Sootio', externalUrl: 'https://sooti.click/donations/banner-click' } as StreamItem;
const video = { name: '🚀 FHD', url: 'https://aio.example/api/v1/debrid/playback/abc', behaviorHints: { filename: 'Show.S01E01.mkv', videoSize: 1 } } as StreamItem;
const embed = { name: 'Lecteur', externalUrl: 'https://vidhost.example/embed/xyz' } as StreamItem;

test('aggregator status rows are infos, not sources', () => {
  assert.equal(infoKind(summary), 'statistic');
  assert.equal(infoKind(partial), 'warning');
  assert.equal(infoKind(error), 'error');
  assert.equal(infoKind(promo), 'promo');
  assert.equal(infoKind(video), null);
  assert.equal(infoKind(embed), null);
});

test('auto mode only opens embed-shaped external links', () => {
  assert.equal(autoWebPlayerUrl({ name: 'x', externalUrl: GH } as StreamItem), null);
  assert.equal(autoWebPlayerUrl(embed), 'https://vidhost.example/embed/xyz');
});
