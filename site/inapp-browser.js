// "Ouvre Huwa dans ton navigateur" for the site pages (/get, /pack, /extensions): same rules as
// the web app (src/web/in-app-browser.ts, tested there). Links tapped in X, Instagram, TikTok…
// open in the app's built-in browser, where the APK download, huwa:// links and AltStore
// buttons often do nothing. Shown once per tab; "Continuer ici" closes it.
(function () {
  var ua = navigator.userAgent || '';
  var APPS = [
    ['X', /Twitter/i],
    ['Instagram', /Instagram/],
    ['Facebook', /FBAN|FBAV|FB_IAB|FBIOS|FB4A/],
    ['TikTok', /musical_ly|Bytedance|TikTok/i],
    ['Snapchat', /Snapchat/],
    ['LinkedIn', /LinkedInApp/],
    ['LINE', /\bLine\//],
  ];
  var name = null;
  var found = false;
  for (var i = 0; i < APPS.length; i++) if (APPS[i][1].test(ua)) { name = APPS[i][0]; found = true; break; }
  if (!found && /Android/.test(ua) && /; wv\)/.test(ua)) found = true;
  if (!found) return;
  try { if (sessionStorage.getItem('huwa/in-app-browser/seen') === '1') return; } catch (e) {}

  var ios = /iPhone|iPad|iPod/.test(ua);
  var android = !ios && /Android/i.test(ua);
  var href = location.href.split('#')[0];
  var rest = href.replace(/^https?:\/\//, '');
  var scheme = location.protocol.replace(':', '');
  var external = android
    ? 'intent://' + rest + '#Intent;scheme=' + scheme + ';action=android.intent.action.VIEW;category=android.intent.category.BROWSABLE;S.browser_fallback_url=' + encodeURIComponent(href) + ';end'
    : ios ? 'x-safari-' + scheme + '://' + rest : null;
  var browser = ios ? 'Safari' : 'ton navigateur';
  var steps = name === 'X'
    ? 'Touche ••• (ou l’icône de partage) en haut de la page, puis « Ouvrir dans ' + browser + ' ».'
    : name === 'Instagram' || name === 'Facebook' || name === 'LinkedIn'
      ? 'Touche ••• en haut à droite, puis « Ouvrir dans ' + browser + ' ».'
      : name === 'TikTok' || name === 'Snapchat'
        ? 'Touche ••• en haut à droite, puis « Ouvrir dans le navigateur ».'
        : 'Copie le lien et colle-le dans ' + (ios ? 'Safari' : 'Chrome ou ton navigateur habituel') + '.';
  var limits = android
    ? 'Ici, l’app Android ne peut pas s’installer et les boutons d’installation ne marchent pas.'
    : ios
      ? 'Ici, les boutons AltStore et l’ajout à l’écran d’accueil ne marchent pas.'
      : 'Ici, les boutons d’installation ne marchent pas.';

  var css =
    '.iab{position:fixed;inset:0;z-index:1000;display:flex;align-items:flex-end;justify-content:center;background:rgba(2,4,9,.72);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}' +
    '.iab-card{width:100%;max-width:480px;background:#0E1422;color:#C3CBDA;border:1px solid rgba(148,165,200,.18);border-radius:22px 22px 0 0;padding:24px 20px calc(24px + env(safe-area-inset-bottom));display:grid;gap:14px;box-shadow:0 -10px 40px rgba(0,0,0,.55)}' +
    '@media (min-width:600px){.iab{align-items:center}.iab-card{border-radius:22px}}' +
    '.iab h2{margin:0;color:#F2F5FA;font-size:22px;line-height:1.2;text-transform:none;letter-spacing:0}' +
    '.iab p{margin:0;font-size:15px}' +
    '.iab-btn{display:flex;align-items:center;justify-content:center;min-height:50px;border-radius:14px;font:inherit;font-weight:700;text-decoration:none;border:1px solid transparent;cursor:pointer}' +
    '.iab-primary{background:#2F6BEB;color:#fff}' +
    '.iab-soft{background:#151C2C;color:#F2F5FA;border-color:rgba(148,165,200,.18)}' +
    '.iab-plain{background:none;color:#7FB0FF;min-height:40px}' +
    '.iab-aside{background:#0C111C;border:1px solid rgba(148,165,200,.18);border-radius:14px;padding:12px 14px;font-size:14px;color:#9AA5BA}' +
    '.iab-aside strong{color:#F2F5FA;display:block;margin-bottom:2px}';

  function show() {
    var style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    var root = document.createElement('div');
    root.className = 'iab';
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', 'Ouvrir Huwa dans ' + browser);
    var card = document.createElement('div');
    card.className = 'iab-card';
    var h = document.createElement('h2');
    h.textContent = name ? 'Tu es dans le navigateur de ' + name : 'Tu es dans un navigateur intégré';
    var p = document.createElement('p');
    p.textContent = limits + ' Ouvre cette page dans ' + browser + ' pour installer Huwa.';
    card.appendChild(h);
    card.appendChild(p);
    if (external) {
      var open = document.createElement('a');
      open.className = 'iab-btn iab-primary';
      open.href = external;
      open.textContent = ios ? 'Ouvrir dans Safari' : 'Ouvrir dans le navigateur';
      card.appendChild(open);
    }
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'iab-btn ' + (external ? 'iab-soft' : 'iab-primary');
    copy.textContent = 'Copier le lien';
    copy.addEventListener('click', function () {
      var done = function () { copy.textContent = 'Lien copié : colle-le dans ' + browser; };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(href).then(done, function () { copy.textContent = href; });
      else copy.textContent = href;
    });
    card.appendChild(copy);
    var aside = document.createElement('div');
    aside.className = 'iab-aside';
    var t = document.createElement('strong');
    t.textContent = 'Le bouton ne fait rien ?';
    aside.appendChild(t);
    aside.appendChild(document.createTextNode(steps));
    card.appendChild(aside);
    var stay = document.createElement('button');
    stay.type = 'button';
    stay.className = 'iab-btn iab-plain';
    stay.textContent = 'Continuer ici';
    stay.addEventListener('click', function () {
      try { sessionStorage.setItem('huwa/in-app-browser/seen', '1'); } catch (e) {}
      root.remove();
    });
    card.appendChild(stay);
    root.appendChild(card);
    document.body.appendChild(root);
  }
  if (document.body) show();
  else document.addEventListener('DOMContentLoaded', show);
})();
