/// <reference types="node" />
// HTTP read-ahead proxy, player side: which links go through it, and HybridPlayer's use of a
// session (the loopback URL handed to mpv, the resume hints, release on every way out, direct
// playback whenever the proxy is not there). The proxy itself is tested in
// native/huwa-torrent-core/tests/http_proxy.rs.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createVideoPlayer, FakeMpvView, mpvViews, resetMedia, type FakeVideoPlayer } from '../../../../../scripts/test-mocks/media.mjs';
import { httpProxyBudget } from '../../../../settings/network-budget';
import { describeProxyError, isProxiable, setHttpProxy, type HttpProxyPort, type ProxyHandle, type ProxyPrefetch } from '../http-proxy';
import { HybridPlayer } from '../hybrid-player';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('only remote file links are proxied', () => {
  assert.ok(isProxiable('https://abc.download.real-debrid.com/d/TOKEN/Show%20-%2001.mkv'));
  assert.ok(isProxiable('http://cdn.example:8080/resolve/x?token=1'));
  assert.ok(!isProxiable('http://127.0.0.1:5555/0123456789abcdef0123456789abcdef01234567/0.mkv'), 'torrent engine');
  assert.ok(!isProxiable('http://127.0.0.1:6000/http/3.mkv'), 'the proxy itself');
  assert.ok(!isProxiable('http://localhost:3000/a.mp4'));
  assert.ok(!isProxiable('http://[::1]:3000/a.mp4'));
  assert.ok(!isProxiable('https://cdn.example/master.m3u8?x=1'), 'HLS: segments are fetched by URL');
  assert.ok(!isProxiable('https://cdn.example/manifest.mpd'));
  assert.ok(!isProxiable('https://cdn.example/stream', 'hls'), 'HLS known from the probe');
  assert.ok(!isProxiable('file:///var/mobile/ep.mkv'));
});

test('read-ahead and target per network', () => {
  assert.deepEqual(httpProxyBudget('unmetered'), { readAhead: 8 * 1024 * 1024, target: true });
  assert.equal(httpProxyBudget('cellular').readAhead, 4 * 1024 * 1024);
  // Low Data Mode / "économie": small read-ahead, no resume guess.
  assert.deepEqual(httpProxyBudget('metered'), { readAhead: 1024 * 1024, target: false });
});

test('upstream refusals are explained', () => {
  const st = (status: number) => ({ length: null, noRange: false, error: { status, message: '' }, bytesFetched: 0, ttfbMs: null });
  assert.match(describeProxyError(st(403))!, /expiré/);
  assert.match(describeProxyError(st(404))!, /introuvable/);
  assert.equal(describeProxyError(st(0)), 'Serveur injoignable');
  assert.equal(describeProxyError(null), null);
});

// ---------- HybridPlayer with a fake proxy ----------

type Opened = { url: string; prefetch: ProxyPrefetch | null; prefetched: ProxyPrefetch[]; released: boolean; handle: ProxyHandle };

function fakeProxy(opts: { status?: { status: number } } = {}) {
  const opened: Opened[] = [];
  const port: HttpProxyPort = {
    enabled: () => true,
    async open(url, _headers, prefetch) {
      await sleep(1);
      const o = { url, prefetch, prefetched: [] as ProxyPrefetch[], released: false } as Opened;
      o.handle = {
        id: opened.length + 1,
        url: `http://127.0.0.1:7777/http/${opened.length + 1}.mkv`,
        prefetch: (p) => o.prefetched.push(p),
        status: async () => ({ length: 1, noRange: false, error: opts.status ? { ...opts.status, message: '' } : null, bytesFetched: 0, ttfbMs: 1 }),
        release: () => {
          o.released = true;
        },
      };
      opened.push(o);
      return o.handle;
    },
  };
  setHttpProxy(port);
  return opened;
}

/** The mpv surface EngineView renders while the engine is mpv. */
function mount(player: HybridPlayer) {
  let view: FakeMpvView | null = null;
  player.subscribeEngine(() =>
    setTimeout(() => {
      if (player.getEngine() === 'mpv' && !view) {
        view = new FakeMpvView();
        view.host = player.mpv;
        player.attachView(view as never);
        setTimeout(() => player.viewDidMount(), 1);
      }
    }, 0),
  );
}

function newPlayer() {
  const p = new HybridPlayer(createVideoPlayer(null) as FakeVideoPlayer as never);
  mount(p);
  return p;
}

afterEach(() => {
  setHttpProxy(null);
  resetMedia();
});

test('mpv opens the proxy URL, with the resume hints, and the session is released on a source switch', async () => {
  const opened = fakeProxy();
  const p = newPlayer();
  const link = 'https://cdn.test/ep1.mkv';
  await p.replaceAsync({ uri: link, headers: { Cookie: 'k=v' } }, { startAt: 600, duration: 1440, size: 1_000_000_000 });
  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, link);
  assert.deepEqual(opened[0].prefetch, { duration: 1440, size: 1_000_000_000, container: 'mkv', startAt: 600 });
  assert.equal(mpvViews.at(-1)!.file, opened[0].handle.url, 'mpv reads the loopback URL');

  await p.replaceAsync({ uri: 'https://cdn.test/ep1-better.mkv' });
  assert.ok(opened[0].released, 'the old link stops downloading');
  assert.equal(opened.length, 2);
  p.stop();
  assert.ok(opened[1].released, 'stop releases');
  p.release();
});

test('native engine, torrent loopback, no proxy: the link plays directly', async () => {
  const opened = fakeProxy();
  const p = newPlayer();
  await p.replaceAsync({ uri: 'https://cdn.test/live.m3u8' });
  assert.equal(p.engine, 'native');
  assert.equal(opened.length, 0);
  const torrent = 'http://127.0.0.1:5555/0123456789abcdef0123456789abcdef01234567/0.mkv';
  await p.replaceAsync({ uri: torrent });
  assert.equal(opened.length, 0);
  assert.equal(mpvViews.at(-1)!.file, torrent);
  p.release();

  setHttpProxy(null);
  const q = newPlayer();
  await q.replaceAsync({ uri: 'https://cdn.test/ep2.mkv' });
  assert.equal(mpvViews.at(-1)!.file, 'https://cdn.test/ep2.mkv');
  q.release();
});

test('a refused link reports the server answer, and release frees the session', async () => {
  const opened = fakeProxy({ status: { status: 403 } });
  const p = newPlayer();
  const errors: string[] = [];
  p.addListener('statusChange', ((e: { status: string; error?: { message: string } }) => {
    if (e.status === 'error' && e.error) errors.push(e.error.message);
  }) as never);
  const loading = p.replaceAsync({ uri: 'https://cdn.test/expired.mkv' });
  await sleep(10);
  p.mpv.onMpvError({ nativeEvent: { message: 'loading failed' } });
  await loading;
  await sleep(5);
  assert.deepEqual(errors, ['Lien refusé ou expiré (HTTP 403)']);
  p.release();
  assert.ok(opened[0].released);
});
