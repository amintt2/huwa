import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanUrl, DEFAULT_CONFIG, parseConfig } from '../config';
import { mixedContent, parseHuwaInfo, parseStremioSettings } from '../streaming-server';

test('cleanUrl keeps http(s) origins and paths, drops the trailing slash', () => {
  assert.equal(cleanUrl('https://huwa.example.org/'), 'https://huwa.example.org');
  assert.equal(cleanUrl(' http://127.0.0.1:11470 '), 'http://127.0.0.1:11470');
  assert.equal(cleanUrl('https://host/s/tok/'), 'https://host/s/tok');
  assert.equal(cleanUrl('javascript:alert(1)'), null);
  assert.equal(cleanUrl('https://user:pw@host'), null);
  assert.equal(cleanUrl('ftp://host'), null);
  assert.equal(cleanUrl(''), null);
  assert.equal(cleanUrl(42), null);
  assert.equal(cleanUrl('wss://host/p2p', true), 'wss://host/p2p');
  assert.equal(cleanUrl('wss://host/p2p'), null);
});

test('parseConfig: missing or malformed file = defaults', () => {
  assert.equal(parseConfig(null), DEFAULT_CONFIG);
  assert.equal(parseConfig('nope'), DEFAULT_CONFIG);
  assert.equal(parseConfig([1, 2]), DEFAULT_CONFIG);
});

test('parseConfig: field by field validation', () => {
  const c = parseConfig({
    instanceName: '  Mon Huwa  ',
    defaultStreamingServer: 'https://stream.example.org/',
    defaultGateway: 'wss://stream.example.org/p2p',
    relayKeys: ['a'.repeat(64), 'bad', 3],
    operatorContact: 'javascript:alert(1)',
    features: { streaming: true, addons: 'yes' },
  });
  assert.equal(c.instanceName, 'Mon Huwa');
  assert.equal(c.defaultStreamingServer, 'https://stream.example.org');
  assert.equal(c.defaultGateway, 'wss://stream.example.org/p2p');
  assert.deepEqual(c.relayKeys, ['a'.repeat(64)]);
  assert.equal(c.operatorContact, null);
  assert.equal(c.features.streaming, true);
  assert.equal(c.features.addons, true); // non-boolean ignored → default
  assert.equal(c.features.p2p, false);
  assert.equal(c.source, 'instance');
});

test('server probe: Huwa /api/v1/info → capability labels, missing features are false', () => {
  const p = parseHuwaInfo({ name: 'huwa-server', version: '0.1.0', api: 1, features: { torrent: true, httpProxy: true, transcode: false } });
  assert.ok(p);
  assert.equal(p.kind, 'huwa');
  assert.equal(p.version, '0.1.0');
  assert.deepEqual(p.features, ['Torrents', 'Proxy HTTP']);
  assert.equal(parseHuwaInfo({ hello: 'world' }), null);
  assert.equal(parseHuwaInfo('x'), null);
});

test('server probe: Stremio /settings', () => {
  const p = parseStremioSettings({ baseUrl: 'http://127.0.0.1:11470', values: { serverVersion: '4.20.8', cacheSize: 2147483648 } });
  assert.ok(p);
  assert.equal(p.kind, 'stremio');
  assert.equal(p.version, '4.20.8');
  assert.equal(parseStremioSettings({ values: {} }), null);
  assert.equal(parseStremioSettings(null), null);
});

test('mixed content: an https page cannot use an http server, except localhost', () => {
  assert.equal(mixedContent('http://192.168.1.10:11470', 'https:'), true);
  assert.equal(mixedContent('http://localhost:11470', 'https:'), false);
  assert.equal(mixedContent('http://127.0.0.1:11470', 'https:'), false);
  assert.equal(mixedContent('https://host', 'https:'), false);
  assert.equal(mixedContent('http://192.168.1.10:11470', 'http:'), false);
});
