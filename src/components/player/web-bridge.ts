// Script injected in the web player's pages (every frame where the platform allows it): finds
// the page's <video> (also inside same-origin iframes), reports its time / duration / end to the
// app, applies the app's commands (seek for resume and AniSkip, play, pause) and neutralises
// window.open. Frames without the native bridge (Android iframes) relay through their parent.
//
// Messages to the app: { h: 'huwa', t: 'time' | 'ended', f: frameId, c: currentTime, d: duration, p: paused }
// Commands from the app: window.__huwa.cmd(name, value, frameId) in the main frame, forwarded to
// every child frame with postMessage.

export type BridgeMessage = { t: 'time' | 'ended'; f: string; c: number; d: number; p: boolean };

export function parseBridgeMessage(data: string): BridgeMessage | null {
  try {
    const m = JSON.parse(data) as Partial<BridgeMessage> & { h?: string };
    if (m?.h !== 'huwa' || (m.t !== 'time' && m.t !== 'ended') || typeof m.f !== 'string') return null;
    const num = (x: unknown) => (typeof x === 'number' && isFinite(x) && x >= 0 ? x : 0);
    return { t: m.t, f: m.f, c: num(m.c), d: num(m.d), p: !!m.p };
  } catch {
    return null;
  }
}

export const commandScript = (name: 'seek' | 'play' | 'pause', value: number, frame: string) =>
  `window.__huwa&&window.__huwa.cmd(${JSON.stringify(name)},${Number(value) || 0},${JSON.stringify(frame)});true;`;

export const BRIDGE_SCRIPT = `(function () {
  if (window.__huwa) return;
  var id = Math.random().toString(36).slice(2, 10);
  var video = null, lastSent = 0;
  function post(m) {
    m.h = 'huwa'; m.f = id;
    var s = JSON.stringify(m);
    try { if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(s); return; } } catch (e) {}
    try { if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ReactNativeWebView) { window.webkit.messageHandlers.ReactNativeWebView.postMessage(s); return; } } catch (e) {}
    try { if (window.parent !== window) window.parent.postMessage({ __huwaUp: s }, '*'); } catch (e) {}
  }
  function up(s) {
    try { if (window.ReactNativeWebView && window.ReactNativeWebView.postMessage) { window.ReactNativeWebView.postMessage(s); return; } } catch (e) {}
    try { if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.ReactNativeWebView) { window.webkit.messageHandlers.ReactNativeWebView.postMessage(s); return; } } catch (e) {}
    try { if (window.parent !== window) window.parent.postMessage({ __huwaUp: s }, '*'); } catch (e) {}
  }
  // No pop-ups: the app also refuses new windows natively.
  try { window.open = function () { return null; }; } catch (e) {}

  function score(v) {
    var d = isFinite(v.duration) ? v.duration : 0;
    var r = v.getBoundingClientRect ? v.getBoundingClientRect() : { width: 0, height: 0 };
    return d * 10 + r.width * r.height / 1000;
  }
  function find(doc, depth) {
    if (!doc) return null;
    var best = null, vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) if (!best || score(vs[i]) > score(best)) best = vs[i];
    if (best || depth > 2) return best;
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var inner = null;
      try { inner = find(fs[j].contentDocument, depth + 1); } catch (e) {}
      if (inner && (!best || score(inner) > score(best))) best = inner;
    }
    return best;
  }
  function send(t) {
    if (!video) return;
    post({ t: t, c: video.currentTime || 0, d: isFinite(video.duration) ? video.duration : 0, p: !!video.paused });
  }
  function attach(v) {
    video = v;
    if (v.__huwaAttached) return;
    v.__huwaAttached = true;
    v.setAttribute('playsinline', '');
    v.addEventListener('timeupdate', function () {
      if (video !== v) return;
      var now = Date.now();
      if (now - lastSent < 1000) return;
      lastSent = now; send('time');
    });
    ['loadedmetadata', 'play', 'pause', 'seeked', 'durationchange'].forEach(function (e) {
      v.addEventListener(e, function () { if (video === v) send('time'); });
    });
    v.addEventListener('ended', function () { if (video === v) send('ended'); });
    send('time');
  }
  setInterval(function () {
    var v = null;
    try { v = find(document, 0); } catch (e) {}
    if (v && v !== video) attach(v);
  }, 1000);

  function run(name, value) {
    if (!video) return;
    try {
      if (name === 'seek') { video.currentTime = value; var p = video.play(); if (p && p.catch) p.catch(function () {}); }
      else if (name === 'play') { var q = video.play(); if (q && q.catch) q.catch(function () {}); }
      else if (name === 'pause') video.pause();
    } catch (e) {}
  }
  function down(msg) {
    for (var i = 0; i < window.frames.length; i++) { try { window.frames[i].postMessage(msg, '*'); } catch (e) {} }
  }
  window.__huwa = {
    cmd: function (name, value, frame) {
      if (!frame || frame === id) run(name, value);
      down({ __huwaCmd: name, v: value, f: frame });
    }
  };
  window.addEventListener('message', function (e) {
    var d = e.data;
    if (!d || typeof d !== 'object') return;
    if (typeof d.__huwaUp === 'string') up(d.__huwaUp);
    else if (d.__huwaCmd) window.__huwa.cmd(d.__huwaCmd, d.v, d.f);
  });
})();
true;`;
