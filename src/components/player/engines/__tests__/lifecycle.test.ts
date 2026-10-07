/// <reference types="node" />
// Player lifecycle under quick taps: HybridPlayer driven like Player.tsx / the watch screen drive
// it, over fake engines (scripts/test-mocks/media.mjs) with real timers. Whatever the order of
// loads, stops and releases, exactly one engine may be heard, on the latest source, and nothing
// stale may start playing later.
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { createVideoPlayer, FakeMpvView, loadDelays, mpvViews, resetMedia, timing, videoPlayers, type FakeVideoPlayer } from '../../../../../scripts/test-mocks/media.mjs';
import { audiblePlayer, HybridPlayer } from '../hybrid-player';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Containers decided from the URL alone: MKV → mpv, HLS → native (policy.ts).
const mkv = (name: string) => `https://cdn.test/${name}.mkv`;
const hls = (name: string) => `https://cdn.test/${name}.m3u8`;

/** Everything that can be heard right now. */
const heard = () => [
  ...videoPlayers.filter((p) => p.audible).map((p) => `native:${p.uri}`),
  ...mpvViews.filter((v) => v.audible).map((v) => `mpv:${v.file}`),
];

/**
 * EngineView stand-in: renders (next macrotask, like a React commit) an mpv surface while the
 * engine is mpv — ref attached, `onReady` a moment later — and tears it down like MpvSurface's
 * cleanup (pause, stop) when the engine goes back to native or the screen unmounts.
 */
function mountSurface(player: HybridPlayer) {
  let view: FakeMpvView | null = null;
  let mounted = true;
  const teardown = () => {
    const h = view;
    if (!h) return;
    view = null;
    player.attachView(null);
    void h.setPaused(true);
    void h.stop();
  };
  const render = () =>
    setTimeout(() => {
      if (!mounted) return;
      const mpv = player.getEngine() === 'mpv';
      if (mpv && !view) {
        const h = new FakeMpvView();
        h.host = player.mpv;
        view = h;
        player.attachView(h as never);
        setTimeout(() => mounted && view === h && player.viewDidMount(), 2);
      } else if (!mpv && view) teardown();
    }, 0);
  const unsubscribe = player.subscribeEngine(render);
  return {
    unmount() {
      mounted = false;
      unsubscribe();
      teardown();
    },
  };
}

/** A watch screen: its Player (source effect, load → play) over its own players. */
class Screen {
  native = createVideoPlayer(null) as FakeVideoPlayer;
  player = new HybridPlayer(this.native as never);
  surface = mountSurface(this.player);
  private alive = { current: false };
  private had = false;

  /** Player.tsx's source effect: the previous run is cancelled, the new source loads then plays. */
  setSource(uri: string | null) {
    this.alive.current = false;
    const alive = { current: true };
    this.alive = alive;
    if (!uri) {
      if (this.had) this.player.stop();
      this.had = false;
      return;
    }
    this.had = true;
    this.player
      .replaceAsync({ uri })
      .then(() => {
        if (alive.current) this.player.play();
      })
      .catch(() => {});
  }

  /** "Épisode suivant": the watch screen stops its player, then navigates. */
  next() {
    this.player.stop();
  }

  /** Screen removed (replace / back): beforeRemove stop, then unmount in React's order. */
  leave() {
    this.player.stop();
    this.alive.current = false;
    this.surface.unmount();
    this.native.release(); // useVideoPlayer's own cleanup
    this.player.release(); // useEnginePlayer's cleanup
  }
}

afterEach(() => resetMedia());

test('a native load overtaking an mpv load keeps the native engine and plays it', async () => {
  const s = new Screen();
  s.setSource(hls('ep1'));
  await sleep(40);
  assert.deepEqual(heard(), [`native:${hls('ep1')}`]);

  // MKV picked (mpv), then a better HLS link: the MKV load is still waiting for the native player
  // to clear when the HLS one starts, and the HLS one plays before that wait ends.
  timing.clearMs = 25;
  s.setSource(mkv('ep1-mkv'));
  await sleep(5);
  s.setSource(hls('ep1-better'));
  await sleep(80);

  assert.equal(s.player.engine, 'native', 'the stale mpv load must not take the engine over');
  assert.deepEqual(heard(), [`native:${hls('ep1-better')}`]);
  assert.equal(s.player.playing, true);
  s.leave();
});

test('load while loading: mpv → mpv → native → mpv ends on the last source only', async () => {
  const s = new Screen();
  s.setSource(mkv('a'));
  await sleep(2);
  s.setSource(mkv('b'));
  await sleep(1);
  s.setSource(hls('c'));
  await sleep(1);
  s.setSource(mkv('d'));
  await sleep(150);

  assert.equal(s.player.engine, 'mpv');
  assert.deepEqual(heard(), [`mpv:${mkv('d')}`]);
  assert.equal(s.player.status, 'readyToPlay');
  s.leave();
  await sleep(20);
  assert.deepEqual(heard(), []);
});

test('release during a load: nothing starts playing afterwards', async () => {
  loadDelays.set('slow', 30);
  const a = new Screen();
  a.setSource(hls('slow-native'));
  await sleep(5);
  a.leave();

  const b = new Screen();
  b.setSource(mkv('slow-mpv'));
  await sleep(4); // the mpv surface is up, its file still opening
  b.leave();

  await sleep(100);
  assert.deepEqual(heard(), []);
  // A late play / load on a released player is a no-op.
  a.player.play();
  await b.player.replaceAsync({ uri: mkv('late') });
  await sleep(40);
  assert.deepEqual(heard(), []);
  assert.equal(audiblePlayer(), null);
});

test('rapid next / next / back: one episode heard, then none', async () => {
  const ep1 = new Screen();
  ep1.setSource(hls('ep1'));
  await sleep(30);
  assert.deepEqual(heard(), [`native:${hls('ep1')}`]);

  // Next: ep1 stops before the navigation; the replaced screen unmounts.
  ep1.next();
  const ep2 = new Screen();
  ep1.leave();
  ep2.setSource(mkv('ep2'));
  await sleep(3);
  // Next again before ep2 even loaded.
  ep2.next();
  const ep3 = new Screen();
  ep2.leave();
  ep3.setSource(hls('ep3'));
  await sleep(100);
  assert.deepEqual(heard(), [`native:${hls('ep3')}`]);
  assert.equal(audiblePlayer(), ep3.player);

  // Back while ep3 plays.
  ep3.leave();
  await sleep(50);
  assert.deepEqual(heard(), []);
});

test('a screen left mounted under a new one is paused when the new one plays', async () => {
  const under = new Screen();
  under.setSource(mkv('ep4'));
  await sleep(40);
  assert.deepEqual(heard(), [`mpv:${mkv('ep4')}`]);

  // Pushed over it (episode opened from the series page): the old screen is still mounted.
  const top = new Screen();
  top.setSource(hls('ep5'));
  await sleep(40);
  assert.deepEqual(heard(), [`native:${hls('ep5')}`]);
  under.leave();
  top.leave();
});

test('the source going away stops playback at once', async () => {
  const s = new Screen();
  s.setSource(mkv('x'));
  await sleep(40);
  assert.deepEqual(heard(), [`mpv:${mkv('x')}`]);
  s.setSource(null); // another source being resolved
  assert.deepEqual(heard(), [], 'silent in the same tick');
  await sleep(20);
  assert.equal(s.player.engine, 'native');
  assert.deepEqual(heard(), []);
  s.setSource(hls('y'));
  await sleep(40);
  assert.deepEqual(heard(), [`native:${hls('y')}`]);
  s.leave();
});

test('spamming play / pause / seek on mpv: no backlog, the last command wins', async () => {
  const s = new Screen();
  s.setSource(mkv('spam'));
  await sleep(40);
  const view = mpvViews.find((v) => v.file === mkv('spam'))!;
  const before = view.calls.length;
  for (let i = 1; i <= 100; i++) {
    s.player.pause();
    s.player.play();
    s.player.currentTime = i * 10;
  }
  s.player.pause();
  await sleep(40);

  const sent: unknown[][] = view.calls.slice(before);
  const pauses = sent.filter((c) => c[0] === 'setPaused');
  const seeks = sent.filter((c) => c[0] === 'seek');
  assert.ok(pauses.length <= 4, `play/pause coalesced (${pauses.length} sent)`);
  assert.ok(seeks.length <= 4, `seeks coalesced (${seeks.length} sent)`);
  assert.deepEqual(pauses.at(-1), ['setPaused', true]);
  assert.deepEqual(seeks.at(-1), ['seek', 1000]);
  assert.deepEqual(heard(), []);
  s.leave();
});

test('an mpv ref detached and attached again (re-render) still takes later loads', async () => {
  const native = createVideoPlayer(null) as FakeVideoPlayer;
  const player = new HybridPlayer(native as never);
  const view = new FakeMpvView();
  view.host = player.mpv;
  const first = player.replaceAsync({ uri: mkv('r1') });
  player.attachView(view as never);
  player.viewDidMount();
  await first;
  // A re-render with a new callback ref: React detaches then attaches the same view; onReady
  // is not sent again.
  player.attachView(null);
  player.attachView(view as never);
  const second = player.replaceAsync({ uri: mkv('r2') });
  const settled = await Promise.race([second.then(() => true), sleep(100).then(() => false)]);
  assert.ok(settled, 'the second load reached the view');
  assert.equal(view.file, mkv('r2'));
  player.release();
});

test('events of an mpv file left behind are ignored', async () => {
  const s = new Screen();
  s.setSource(mkv('old'));
  await sleep(40);
  const old = mpvViews.find((v) => v.file === mkv('old'))!;
  s.setSource(hls('new'));
  await sleep(40);
  const statuses: string[] = [];
  const sub = s.player.addListener('statusChange', ({ status }) => statuses.push(status));
  // Late events of the torn-down mpv core, delivered after the switch.
  old.host!.onMpvError({ nativeEvent: { message: 'stale' } });
  old.host!.onLoaded({ nativeEvent: { duration: 1, tracks: '[]', videoCodec: 'h264', hwdec: 'no' } });
  old.host!.onEnd();
  sub.remove();
  assert.deepEqual(statuses, []);
  assert.equal(s.player.status, 'readyToPlay');
  assert.deepEqual(heard(), [`native:${hls('new')}`]);
  s.leave();
});
