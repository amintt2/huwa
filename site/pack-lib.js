// Huwa extension packs on the web (same format and rules as the app: src/packs/format.ts).
// A pack travels inside the link: https://huwa.mciut.fr/pack.html#<payload> (the fragment is
// never sent to the server) or huwa://pack?d=<payload>. <payload> = base64url(JSON) or
// "z" + base64url(raw DEFLATE of the JSON). A hosted pack: huwa://pack?url=<pack JSON URL>.
(function () {
  const MAX_ENTRIES = 50;
  const MAX_SOURCES = 50;
  const MAX_JSON = 64 * 1024;
  const MAX_PAYLOAD = 48 * 1024;
  const SITE = 'https://huwa.mciut.fr';

  function fail(msg) { throw new Error(msg); }

  function b64urlToBytes(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function bytesToB64url(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  async function pipe(bytes, stream, limit) {
    const reader = new Blob([bytes]).stream().pipeThrough(stream).getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (limit && size > limit) { reader.cancel(); fail('Pack trop volumineux'); }
      chunks.push(value);
    }
    const out = new Uint8Array(size);
    let o = 0;
    for (const c of chunks) { out.set(c, o); o += c.length; }
    return out;
  }

  const clean = (v, max) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');

  function httpUrl(v, what) {
    if (typeof v !== 'string' || v.length > 2048) fail('Pack invalide : ' + what);
    let u;
    try { u = new URL(v.trim()); } catch { fail('Pack invalide : ' + what); }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') fail('Pack invalide : ' + what + ' doit être une adresse http(s)');
    if (u.username || u.password) fail('Pack invalide : ' + what + ' contient un identifiant');
    const h = u.hostname.replace(/^\[|\]$/g, '');
    if (h === 'localhost' || h.endsWith('.localhost') || /^(127\.|0\.|169\.254\.)/.test(h) || h === '::1' || h === '0.0.0.0') fail('Pack invalide : adresse locale');
    return v.trim();
  }
  const canonicalManifest = (u) => u.replace(/[?#].*$/, '').replace(/\/manifest\.json$/i, '').replace(/\/configure\/?$/i, '').replace(/\/+$/, '') + '/manifest.json';
  const canonicalRepo = (u) => u.replace(/[?#].*$/, '').replace(/\/(versioning\.json|index\.html)$/i, '').replace(/\/+$/, '');
  const key = (u) => u.replace(/^https?:\/\//i, '').toLowerCase();

  function validate(j) {
    if (!j || typeof j !== 'object' || Array.isArray(j)) fail('Ce n’est pas un pack Huwa');
    if (j.huwaPack !== 1) fail(typeof j.huwaPack === 'number' && j.huwaPack > 1 ? 'Pack créé par une version plus récente de Huwa' : 'Ce n’est pas un pack Huwa');
    const name = clean(j.name, 80);
    if (!name) fail('Pack invalide : il n’a pas de nom');
    const video = j.video == null ? [] : j.video;
    const manga = j.manga == null ? [] : j.manga;
    if (!Array.isArray(video) || !Array.isArray(manga)) fail('Pack invalide');
    if (video.length + manga.length > MAX_ENTRIES * 2) fail('Pack trop grand (' + MAX_ENTRIES + ' extensions maximum)');
    const out = { huwaPack: 1, name, video: [], manga: [] };
    const seen = new Set();
    for (const e of video) {
      if (!e || typeof e !== 'object') fail('Pack invalide : entrée vidéo');
      const manifest = canonicalManifest(httpUrl(e.manifest, 'lien du manifest'));
      if (seen.has(key(manifest))) continue;
      seen.add(key(manifest));
      const n = clean(e.name, 80);
      out.video.push(n ? { manifest, name: n } : { manifest });
    }
    const repos = new Map();
    for (const e of manga) {
      if (!e || typeof e !== 'object') fail('Pack invalide : entrée manhwa');
      const repo = canonicalRepo(httpUrl(e.repo, 'adresse du dépôt'));
      if (e.sources !== undefined && !Array.isArray(e.sources)) fail('Pack invalide : sources');
      const sources = (e.sources || []).map((s) => { if (typeof s !== 'string' || !/^[A-Za-z0-9_.-]{1,64}$/.test(s)) fail('Pack invalide : source'); return s; });
      const n = clean(e.name, 80);
      const prev = repos.get(key(repo));
      if (prev) {
        const merged = [...new Set([...(prev.sources || []), ...sources])];
        if (merged.length) prev.sources = merged;
        if (!prev.name && n) prev.name = n;
      } else {
        const entry = { repo };
        if (sources.length) entry.sources = [...new Set(sources)];
        if (n) entry.name = n;
        repos.set(key(repo), entry);
        out.manga.push(entry);
      }
    }
    if (out.manga.some((m) => (m.sources || []).length > MAX_SOURCES)) fail('Pack trop grand (' + MAX_SOURCES + ' sources maximum par dépôt)');
    if (out.video.length + out.manga.length > MAX_ENTRIES) fail('Pack trop grand (' + MAX_ENTRIES + ' extensions maximum)');
    if (!out.video.length && !out.manga.length) fail('Ce pack ne contient aucune extension');
    const description = clean(j.description, 500);
    const author = clean(j.author, 60);
    if (description) out.description = description;
    if (author) out.author = author;
    return out;
  }

  function parseJson(text) {
    if (text.length > MAX_JSON) fail('Pack trop volumineux');
    let j;
    try { j = JSON.parse(text); } catch { fail('Ce n’est pas un pack Huwa (JSON illisible)'); }
    return validate(j);
  }

  function minified(p) {
    const o = { huwaPack: 1, name: p.name };
    if (p.description) o.description = p.description;
    if (p.author) o.author = p.author;
    o.video = p.video;
    o.manga = p.manga;
    return JSON.stringify(o);
  }

  async function decode(d) {
    d = String(d || '').trim();
    if (!d) fail('Lien de pack vide');
    if (d.length > MAX_PAYLOAD) fail('Lien de pack trop long');
    if (!/^z?[A-Za-z0-9_-]+$/.test(d)) fail('Lien de pack abîmé');
    let bytes;
    try {
      if (d[0] === 'z') {
        if (typeof DecompressionStream === 'undefined') fail('Navigateur trop ancien pour lire ce pack : ouvre-le directement dans Huwa');
        bytes = await pipe(b64urlToBytes(d.slice(1)), new DecompressionStream('deflate-raw'), MAX_JSON);
      } else bytes = b64urlToBytes(d);
    } catch (e) {
      if (/volumineux|Navigateur/.test(e.message)) throw e;
      fail('Lien de pack abîmé (il a peut-être été coupé)');
    }
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { fail('Lien de pack abîmé'); }
    return parseJson(text);
  }

  async function encode(pack) {
    const bytes = new TextEncoder().encode(minified(validate(pack)));
    const plain = bytesToB64url(bytes);
    if (typeof CompressionStream === 'undefined') return plain;
    const packed = 'z' + bytesToB64url(await pipe(bytes, new CompressionStream('deflate-raw')));
    return packed.length < plain.length ? packed : plain;
  }

  async function fetchPack(url) {
    const res = await fetch(url, { headers: { Accept: 'application/json' }, credentials: 'omit' });
    if (!res.ok) fail('HTTP ' + res.status);
    return parseJson(await res.text());
  }

  /** Pasted text → { d } | { url } | { json: pack } | null. */
  async function parseInput(raw) {
    const s = String(raw || '').trim();
    if (!s) return null;
    if (s[0] === '{') return { json: parseJson(s) };
    let m = /^huwa:\/\/\/?pack\/?\?(.*)$/i.exec(s) || /^https?:\/\/[^/]+\/pack(?:\.html)?\/?(?:\?[^#]*)?#(.*)$/i.exec(s);
    if (m) {
      const q = new URLSearchParams(m[1].replace(/#.*$/, ''));
      if (q.get('d')) return { d: q.get('d') };
      if (q.get('url')) return { url: httpUrl(q.get('url'), 'adresse du pack') };
      if (/^z?[A-Za-z0-9_-]+$/.test(m[1])) return { d: m[1] };
      fail('Lien de pack incomplet');
    }
    if (/^z?[A-Za-z0-9_-]{16,}$/.test(s)) return { d: s };
    if (/^https?:\/\//i.test(s)) return { url: httpUrl(s, 'adresse du pack') };
    fail('Colle l’adresse d’un fichier de pack (.json), un lien de pack ou le JSON du pack');
  }

  const appLink = (ref) => (ref.d ? 'huwa://pack?d=' + ref.d : 'huwa://pack?url=' + encodeURIComponent(ref.url));
  const pageLink = (ref) => SITE + '/pack.html#' + (ref.d ? ref.d : 'url=' + encodeURIComponent(ref.url));
  const host = (u) => { try { return new URL(u).host; } catch { return u; } };

  /** QR code of `text` into `el` (qrcodejs); false when the link is too long for a QR code. */
  function qr(el, text) {
    el.innerHTML = '';
    if (!window.QRCode) { el.textContent = 'QR code indisponible'; return false; }
    if (text.length > 1200) return false;
    try {
      new QRCode(el, { text, width: 180, height: 180, correctLevel: QRCode.CorrectLevel.L });
      return true;
    } catch {
      el.innerHTML = '';
      return false;
    }
  }

  window.HuwaPack = { decode, encode, validate, parseJson, fetchPack, parseInput, appLink, pageLink, host, qr };
})();
