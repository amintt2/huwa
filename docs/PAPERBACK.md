# Extensions Paperback dans Huwa

Huwa sait installer et exécuter les **extensions de l'app Paperback** (iOS) pour lire de vrais chapitres de manhwa / manga dans son lecteur. Modèle « app bibliothèque » : Huwa ne fournit **aucune** extension ni dépôt ; l'utilisateur ajoute les dépôts de son choix et reste responsable des sources qu'il installe.

Code : `src/manga-ext/` (moteur, dépôts, validation), `src/app/manga-sources.tsx` (écran « Extensions manhwa »), `src/components/paperback.tsx` (recherche, panneau source), `src/app/paperback.tsx` (lien profond).

## 1. Les formats (sources primaires)

Vérifié sur les paquets npm publiés par l'équipe Paperback et sur des dépôts publics (septembre 2026).

| App Paperback | Paquet de types | Toolchain | Fichier de la source | Globals attendus |
|---|---|---|---|---|
| 0.6 / 0.7 | `paperback-extensions-common` 4.x / 5.0-alpha | `paperback-cli` | `source.js` (browserify) | `createManga`, `createRequestObject`… — **non pris en charge** |
| **0.8** (App Store) | `@paperback/types` **0.8.x** | `@paperback/toolchain` 0.8.x (esbuild) | `<Id>/source.js` | `App.*` |
| **0.9** (dernière, « v2 ») | `@paperback/types` **1.0.0-alpha.x** | `@paperback/toolchain` 1.0.0-alpha (rolldown) | `<Id>/index.js` | `Application.*` |

Précision : le « nouveau système » que la communauté appelle 0.9 est construit avec `@paperback/types@1.0.0-alpha` (et non `paperback-extensions-common`, qui est l'ancêtre 0.6/0.7). Une app 0.9 accepte aussi les extensions 0.8 ; Huwa fait de même (priorité 0.9, 0.8 pris en charge).

Références lues : `@paperback/types` 0.8.7 et 1.0.0-alpha.92, `@paperback/toolchain` 0.8.7 et 1.0.0-alpha.92 (`bundle`, `test`, page d'accueil générée), `@paperback/runtime-polyfills` 0.8.7 et 1.0.0-alpha.92 (implémentation Node des globals, utilisée par la toolchain pour tester les extensions).

### 1.1 Structure d'un dépôt

Un dépôt est un dossier statique (souvent GitHub Pages) :

```
<dépôt>/versioning.json
<dépôt>/index.html                       page « Add to Paperback »
0.8 : <dépôt>/<Id>/source.js             <dépôt>/<Id>/includes/<icône>
0.9 : <dépôt>/<Id>/index.js              <dépôt>/<Id>/static/<icône>   <dépôt>/<Id>/info.json
```

`versioning.json` :

- 0.8 : `{ buildTime, builtWith: { toolchain, types: "0.8.x" }, sources: [{ id, name, author, desc, website, contentRating: EVERYONE|MATURE|ADULT, version, icon, tags: [{text,type}], websiteBaseURL, intents }] }`
- 0.9 : `{ buildTime, builtWith: { toolchain, types: "1.0.0-alpha.x" }, repository: { name, description }, sources: [{ id, name, description, version, icon, language, contentRating: SAFE|MATURE|ADULT, badges: [{label,…}], capabilities: [bits], developers: [{name,website,github}] }] }`

Liens de dépôt :
- `paperback://addRepo?displayName=<nom>&url=<dépôt>` (pages 0.8 et 0.9) ;
- `paperback://installExtensions?data=<base64 JSON [[id, dépôt], …]>` (pages 0.9, sources cochées) ;
- Huwa : `huwa://paperback?repo=<dépôt>`. Huwa n'enregistre pas le schéma `paperback://` (il appartient à Paperback) : ces liens se **collent** dans le champ de l'écran « Extensions manhwa ».

### 1.2 Le bundle

- **0.8** : IIFE esbuild, `globalName: '_Sources'`, pied de page `this.Sources = _Sources`. Exporte la classe `Sources[Id]` et `Sources[Id + 'Info']` (SourceInfo). L'app instancie `new Sources[Id](cheerio)` : **cheerio est fourni par l'app** (1.0.0-rc.12).
- **0.9** : IIFE rolldown `var source = (function(e){ … return e.<Id> = new Classe(), e })({})`, cible es2020. Exporte une **instance** ; l'app appelle `await source[Id].initialise()`. Le bundle embarque ses dépendances (cheerio compris) et les classes utilitaires de `@paperback/types` (`BasicRateLimiter`, `CookieStorageInterceptor`, `PaperbackInterceptor`, `URL`, formulaires).

### 1.3 API d'une source

| | 0.8 (`Source` / interfaces) | 0.9 (`Extension` + capacités) |
|---|---|---|
| Détails | `getMangaDetails(mangaId) → SourceManga {id, mangaInfo{image, desc, status, titles[], author, artist, tags[TagSection], hentai, rating, banner}}` | `getMangaDetails(mangaId) → SourceManga {mangaId, mangaInfo{thumbnailUrl, synopsis, primaryTitle, secondaryTitles, contentRating, status, tagGroups, artworkUrls, additionalInfo, shareUrl}}` |
| Chapitres | `getChapters(mangaId) → Chapter[] {id, chapNum, langCode, name, volume, group, time, sortingIndex}` | `getChapters(sourceManga, sinceDate?) → Chapter[] {chapterId, sourceManga, langCode, chapNum, title, version, volume, publishDate, creationDate, sortingIndex, additionalInfo}` |
| Pages | `getChapterDetails(mangaId, chapterId) → {id, mangaId, pages[]}` | `getChapterDetails(chapter) → {id, mangaId, pages[]}` ou `{type:'html'}` / `{type:'file'}` (romans, epub/pdf/cbz) |
| Recherche | `getSearchResults({title, includedTags, excludedTags, parameters}, metadata) → PagedResults {results: PartialSourceManga[], metadata}` | `getSearchResults({title, metadata}, metadata, sortingOption) → PagedResults {items: SearchResultItem[], metadata}` + `getSortingOptions`, `getAdvancedSearchForm` |
| Accueil | `getHomePageSections(cb)`, `getViewMoreItems(id, metadata)` | `getDiscoverSections()`, `getDiscoverSectionItems(section, metadata)` |
| Réglages | `getSourceMenu() → DUISection` (App.createDUI…) | `getSettingsForm() → Form` (SettingsUI) |
| Divers | `getCloudflareBypassRequestAsync`, suivi (`MangaProgressProviding`) | `CloudflareBypassRequestProviding`, `MangaProgressProviding`, `ManagedCollectionProviding`, `processTitlesForUpdates` |

### 1.4 Globals fournis par l'app

**0.8 — `App`** : tous les `App.createX(info)` sont de simples constructeurs de données (le polyfill officiel est un `Proxy` qui renvoie `info`), sauf :
- `App.createRequestManager({interceptor, requestsPerSecond, requestTimeout})` → `RequestManager.schedule(request, retry) → Response {data (texte), rawData, status, headers, request}` ; l'intercepteur a `interceptRequest(req)` et `interceptResponse(res)`. `Request {url, method, headers, data, param, cookies[]}` ; `param` est concaténé à l'URL.
- `App.createSourceStateManager()` → `store/retrieve` async + `keychain` (stockage sécurisé).
- `App.createRawData`, `App.createByteArray`.

**0.9 — `Application`** : `scheduleRequest(req) → [Response {url, headers, status, mimeType, cookies}, ArrayBuffer]` ; intercepteurs enregistrés par identifiant de **sélecteur** (`registerInterceptor(id, reqSel, resSel)`, `Application.Selector(obj, 'méthode')`, `SelectorRegistry`) ; `getState/setState/getSecureState/setSecureState` **synchrones** ; `arrayBufferToUTF8String/ASCII/UTF16`, `base64Encode/Decode`, `crypto_md5Hash`, `decodeHTMLEntities`, `sleep`, `getDefaultUserAgent`, `registerDiscoverSection`…, `executeInWebView`, `isResourceLimited`, `filterAdultTitles`, `filterMatureTitles`, `formDidChange` (utilisé par les formulaires). `Request {url, method, headers?, body?: ArrayBuffer|object|string, cookies?: Record}`.

## 2. Runtime dans Huwa

### 2.1 Choix : WebView cachée + une iframe `sandbox` par source

Options étudiées :

1. **Worklet Bare** (react-native-bare-kit, déjà embarqué pour le P2P) — écarté. Un worklet est bien un autre moteur JS, mais ce n'est pas un bac à sable : le global `Bare` est non configurable et expose `Bare.Addon` (chargement d'addons natifs) et `Bare.Thread`. Vérifié avec le runtime Bare 1.34 : du code évalué via `new Function` récupère le global, crée un `Bare.Thread` avec un source arbitraire, et ce thread obtient un `require` de module (donc `bare-fs`, `bare-tcp` embarqués dans BareKit → fichiers de l'app, sockets hors politique réseau). Impossible à masquer (`delete`/`defineProperty` refusés).
2. **Runtime JSI séparé** (react-native-worklets) — écarté : le code doit être « workletisé » à la compilation, et le runtime garde des ponts vers les autres runtimes.
3. **WKWebView cachée** — retenu :
   - moteur **JavaScriptCore**, le même que Paperback (compatibilité maximale, JIT) ;
   - isolation par le navigateur : chaque source tourne dans une `<iframe sandbox="allow-scripts">` (origine opaque, pas de `allow-same-origin`) : aucun accès à l'app, aux autres sources, aux cookies ni au stockage ;
   - CSP `default-src 'none'` dans l'iframe : pas de `fetch`/XHR/WebSocket/images/navigation directs ; le **seul canal** est `parent.postMessage`. La page parente (la nôtre) étiquette chaque message avec l'iframe émettrice (`event.source`, infalsifiable) ;
   - la WebView est `incognito`, sans cache, sans fenêtres, navigation limitée à `about:blank` / `about:srcdoc` (`onShouldStartLoadWithRequest`), jamais transmise à `Linking` ;
   - si une source boucle (le thread de la WebView est partagé), l'app le détecte (ping) et recharge le moteur.

Dépendance ajoutée : `react-native-webview` 13.16.1 (version Expo 57).

### 2.2 Chemin d'un appel

```
UI → api.ts → bridge.ts ──injectJavaScript──▶ page hôte ──postMessage──▶ iframe (sandbox.ts + cheerio + bundle de la source)
                  ▲                                                          │
                  └──── onMessage ◀──── page hôte (tag = iframe) ◀───────────┘  {req http} / {state} / {ret}
bridge.ts : req http → net.ts (politique + fetch RN) ; state → state.ts ; ret → validate.ts → UI
```

- `runtime/sandbox.ts` : recrée `App` (0.8) et `Application` (0.9) d'après les polyfills officiels, évalue le bundle (eval indirect dans l'iframe), instancie la source, exécute `details | chapters | pages | search | imageHeaders`, sérialise le résultat (Dates → ISO, `sourceManga` retiré de chaque chapitre, taille ≤ 8 Mo). Construit par esbuild avec cheerio 1.0.0-rc.12 (`npm run build:paperback`, lancé au `postinstall`, fichier généré ignoré par git).
- `net.ts` (côté app, jamais dans la source) : http(s) uniquement, refus de loopback / link-local (le LAN reste permis pour les serveurs auto-hébergés), en-têtes filtrés (pas de `Host`, `Content-Length`, CRLF…), corps ≤ 1 Mo, réponse ≤ 12 Mo, délai 3–45 s, **débit par source** (≤ 8 req/s, 4 en parallèle ; `requestsPerSecond` de la source respecté), **cookies par source** (jar RFC 6265 simplifié, persistant ; `credentials: 'omit'` pour ne jamais mêler les cookies de l'app), User-Agent Safari iOS par défaut, URL échappées comme le fait Paperback (espaces, accents).
- `state.ts` : état par source dans AsyncStorage (≤ 512 Ko, valeur ≤ 64 Ko), état « sécurisé » dans le Trousseau via SecureStore (≤ 2 Ko), préchargé dans l'iframe (les lectures 0.9 sont synchrones), écritures renvoyées à l'app.
- `validate.ts` : tout ce qui sort d'une source est retypé et borné (≤ 10 000 chapitres, ≤ 2 000 pages, URL http(s) uniquement, textes coupés, langues normalisées — MangaDex 0.9 renvoie un drapeau emoji —, en-têtes d'image limités à Referer/Origin/UA/Cookie/Accept/Authorization/`x-*`).

### 2.3 Intégration dans l'app

- **Dépôts / sources** (`registry.ts`) : ajout par URL ou lien, liste, installation (bundle ≤ 6 Mo enregistré dans `Documents/paperback/<clé>.js`), mise à jour (comparaison de versions, alpha comprises), activation, suppression (efface l'état et les liens). Rappel légal à la première installation. Sources « Adulte » masquées par défaut.
- **Recherche** : bloc « Dans tes sources » dans l'écran Recherche (une rangée par source).
- **Fiche** (`link.ts`) : ouvrir un résultat récupère détails + chapitres. Si un titre (normalisé) correspond à un titre / synonyme AniList, la série est rattachée à la fiche AniList (`al…` / `alm…`) : le pont épisode ↔ chapitre continue de marcher avec les vrais chapitres. Sinon fiche autonome `px…`. Les chapitres réels remplacent les chapitres fictifs (`setChapterOverlay`), un par numéro dans la langue choisie (sélecteur de langue), ids `<série>-c<numéro>` pour garder la progression. Sur une fiche AniList non liée : « Trouver dans mes sources ».
- **Lecteur** : `registerPageSource` renvoie pages + en-têtes (l'intercepteur de la source est appliqué à une requête d'image, plus les cookies du jar) → `expo-image` avec ces en-têtes ; préchargement des pages suivantes et du début du chapitre suivant ; reprise à la page ; navigation précédent/suivant par position ; téléchargement hors-ligne ; écran d'erreur avec « Réessayer ».
- **Bibliothèque** : une fiche de source s'ajoute à « Ma liste » comme les autres (elle est enregistrée dans le catalogue).

## 3. Vérifications

- `npm test` : parsing des dépôts 0.8/0.9 et des liens, validation, politique réseau et cookies, runtime complet (bundle esbuild réel exécuté dans un contexte `vm` sans globals Node) avec une extension 0.8 et une 0.9 synthétiques au format exact des toolchains.
- `npm run test:paperback-live` (réseau) : dépôts publics réels, jamais embarqués dans l'app — Inkdex 0.9 (`https://inkdex.github.io/extensions/0.9/stable`, sources **Webtoon** et **MangaDex**) et Netsky 0.8 (`https://thenetsky.github.io/community-extensions/0.8`, **MangaDex**) : versioning → bundle → recherche → détails → chapitres → pages → téléchargement de la page 1 avec les en-têtes de la source.

## 4. Limites connues

- Pas d'interface pour les **réglages de source** (DUI 0.8 / SettingsUI 0.9) : les sources utilisent leurs valeurs par défaut (ex. langue de MangaDex).
- Pas de **contournement Cloudflare** (`executeInWebView`, cookies de vérification) : ces sources renvoient une erreur explicite.
- Pas de pages d'**accueil / Découvrir** des sources, ni de filtres de recherche avancés (tags, tri autre que le premier proposé), ni de pagination des résultats.
- Pas de suivi (`MangaProgressProviding`), de collections gérées, ni de chapitres « roman » / fichiers (epub, pdf, cbz).
- Images qui exigent un traitement de la réponse (déchiffrement, ex. MangaPlus) : non prises en charge ; les en-têtes d'image sont calculés sur la première page du chapitre.
- Corps de requête « objet » en 0.9 envoyés en JSON (ou formulaire si `Content-Type` l'indique) : comportement de l'app Paperback non documenté.
- Format 0.6/0.7 (`paperback-extensions-common`) refusé.
