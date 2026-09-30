// HTML of the hidden WebView that hosts the extensions (see docs/PAPERBACK.md, "Runtime").
//
// Parent page (ours): creates one `<iframe sandbox="allow-scripts">` per loaded source and relays
// messages. The iframe has an opaque origin (no `allow-same-origin`): it cannot read the parent,
// the other iframes, cookies or storage, and its CSP (`default-src 'none'`) forbids fetch, XHR,
// WebSocket, images and navigation. Its only channel is `parent.postMessage`; the parent tags each
// message with the iframe it came from (`event.source`, unforgeable) before handing it to the app.
const CSP = "default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'";

/** Escapes a script so it can live inside an inline <script> element. */
const inline = (js: string) => js.replace(/<\/script/gi, '<\\/script');

export function frameHtml(runtime: string) {
  const boot = `(function(){var P=HuwaPB;delete window.HuwaPB;P.start({send:function(s){parent.postMessage(s,'*')},onMessage:function(cb){addEventListener('message',function(e){if(e.source===parent&&typeof e.data==='string')cb(e.data)})}},P.cheerio)})();`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${inline(runtime)}</script><script>${boot}</script></body></html>`;
}

export function hostHtml(runtime: string) {
  const frame = JSON.stringify(frameHtml(runtime)).replace(/<\//g, '<\\/');
  const script = `
var FRAME=${frame};
var frames={};
function out(o){window.ReactNativeWebView.postMessage(JSON.stringify(o));}
function kill(k){var f=frames[k];if(f){delete frames[k];f.remove();}}
window.__huwaIn=function(raw){
  var m=JSON.parse(raw);
  if(m.t==='spawn'){kill(m.key);var f=document.createElement('iframe');f.setAttribute('sandbox','allow-scripts');f.style.cssText='width:1px;height:1px;border:0;position:absolute;left:-10px;top:0';f.srcdoc=FRAME;frames[m.key]=f;document.body.appendChild(f);}
  else if(m.t==='kill'){kill(m.key);}
  else if(m.t==='ping'){out({t:'pong'});}
  else if(m.t==='to'){var t=frames[m.key];if(t&&t.contentWindow)t.contentWindow.postMessage(m.msg,'*');}
};
addEventListener('message',function(e){
  if(typeof e.data!=='string'||e.data.length>16777216)return;
  for(var k in frames){if(frames[k].contentWindow===e.source){out({t:'from',key:k,msg:e.data});return;}}
});
out({t:'host-ready'});`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${CSP}"></head><body><script>${script}</script></body></html>`;
}
