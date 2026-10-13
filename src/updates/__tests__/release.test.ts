/// <reference types="node" />
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apkUpdate, isNewer } from '../release';

const asset = (name: string) => ({ name, browser_download_url: `https://github.com/amintt2/huwa/releases/download/v1.0.2/${name}` });
const release = {
  tag_name: 'v1.0.2',
  html_url: 'https://github.com/amintt2/huwa/releases/tag/v1.0.2',
  assets: [asset('Huwa-1.0.2.apk'), asset('Huwa-1.0.2-arm64-v8a.apk'), asset('Huwa-1.0.2-armeabi-v7a.apk'), asset('Huwa-1.0.2.ipa')],
};

test('versions compare numerically', () => {
  assert.ok(isNewer('1.0.10', '1.0.9'));
  assert.ok(isNewer('v1.1', '1.0.9'));
  assert.ok(!isNewer('1.0.1', '1.0.1'));
  assert.ok(!isNewer('1.0.0', '1.0.1'));
  assert.ok(!isNewer('nightly', '1.0.0'));
});

test('the APK for the device ABI, else the universal one', () => {
  assert.match(apkUpdate(release, '1.0.1', ['arm64-v8a', 'armeabi-v7a'])!.url, /arm64-v8a\.apk$/);
  assert.match(apkUpdate(release, '1.0.1', ['x86_64'])!.url, /Huwa-1\.0\.2\.apk$/);
  assert.equal(apkUpdate(release, '1.0.1', [])!.version, '1.0.2');
});

test('nothing to offer when up to date, for a pre-release, or without an APK yet', () => {
  assert.equal(apkUpdate(release, '1.0.2', ['arm64-v8a']), null);
  assert.equal(apkUpdate({ ...release, prerelease: true }, '1.0.1', ['arm64-v8a']), null);
  assert.equal(apkUpdate({ ...release, assets: [asset('Huwa-1.0.2.ipa')] }, '1.0.1', ['arm64-v8a']), null);
});
