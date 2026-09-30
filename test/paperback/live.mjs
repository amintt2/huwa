// Live compatibility check against real public Paperback repositories (network required, not part
// of `npm test`): npm run test:paperback-live [-- <repoUrl> <SourceId> <query>]
// Nothing here is shipped with the app; the repositories are only used to verify the runtime.
import { createNodeSandbox, nodeNet } from '../../src/manga-ext/__tests__/harness.ts';
import { bundleUrl, parseVersioning, sourceKey, versioningUrl } from '../../src/manga-ext/repo.ts';
import { normalizeChapters, normalizeDetails, normalizeImageHeaders, normalizePages, normalizeSearch } from '../../src/manga-ext/validate.ts';

const DEFAULT_CASES = [
  // Inkdex community registry, Paperback 0.9 (@paperback/types 1.0.0-alpha)
  { repo: 'https://inkdex.github.io/extensions/0.9/stable', id: 'Webtoon', query: 'Tower of God' },
  { repo: 'https://inkdex.github.io/extensions/0.9/stable', id: 'MangaDex', query: 'Kaguya-sama Love Is War' },
  // Netsky's community extensions, Paperback 0.8 (@paperback/types 0.8)
  { repo: 'https://thenetsky.github.io/community-extensions/0.8', id: 'MangaDex', query: 'Kaguya-sama Love Is War' },
];

const args = process.argv.slice(2);
const cases = args.length >= 3 ? [{ repo: args[0], id: args[1], query: args.slice(2).join(' ') }] : DEFAULT_CASES;
const net = nodeNet();
let failures = 0;

for (const c of cases) {
  const tag = `[${c.id} @ ${c.repo}]`;
  const t0 = Date.now();
  try {
    const index = parseVersioning(await (await fetch(versioningUrl(c.repo))).json(), c.repo);
    const info = index.sources.find((s) => s.id === c.id);
    if (!info) throw new Error('source absente du dépôt');
    console.log(`${tag} dépôt "${index.name}" format ${index.format} (types ${index.types}), ${index.sources.length} sources, ${c.id} v${info.version}`);

    const code = await (await fetch(bundleUrl(index.url, index.format, c.id))).text();
    const key = sourceKey(index.url, c.id);
    const sb = await createNodeSandbox((req) => net.request(key, req));
    await sb.load(c.id, index.format, code);
    console.log(`${tag} bundle ${(code.length / 1024).toFixed(0)} Ko chargé`);

    const search = normalizeSearch(index.format, await sb.call('search', c.query, null));
    if (!search.items.length) throw new Error('recherche vide');
    const hit = search.items[0];
    console.log(`${tag} recherche "${c.query}": ${search.items.length} résultats, 1er = ${hit.title} (${hit.mangaId})`);

    const details = normalizeDetails(index.format, await sb.call('details', hit.mangaId), hit.mangaId);
    console.log(`${tag} détails: ${details.title} · ${details.status} · ${details.tags.slice(0, 3).join(', ')} · image ${details.image ? 'oui' : 'non'}`);

    const chapters = normalizeChapters(index.format, await sb.call('chapters', index.format === '0.9' ? details.sourceManga : hit.mangaId));
    if (!chapters.length) throw new Error('aucun chapitre');
    const langs = [...new Set(chapters.map((ch) => ch.lang))];
    console.log(`${tag} ${chapters.length} chapitres (langues ${langs.slice(0, 6).join(', ')})`);

    const ch = chapters.find((x) => x.lang === 'en') ?? chapters[0];
    const pagesRaw = index.format === '0.9' ? await sb.call('pages', ch.raw, details.sourceManga) : await sb.call('pages', hit.mangaId, ch.chapterId);
    const { pages } = normalizePages(index.format, pagesRaw);
    const headers = normalizeImageHeaders(await sb.call('imageHeaders', pages[0]));
    const img = await fetch(pages[0], { headers });
    const type = img.headers.get('content-type');
    const bytes = (await img.arrayBuffer()).byteLength;
    if (!img.ok || !/^image\//.test(type ?? '')) throw new Error(`page 1 illisible: ${img.status} ${type}`);
    console.log(`${tag} chapitre ${ch.number} (${ch.lang}): ${pages.length} pages; page 1 → ${img.status} ${type} ${(bytes / 1024).toFixed(0)} Ko; en-têtes ${JSON.stringify(headers ?? {})}`);
    console.log(`${tag} OK en ${((Date.now() - t0) / 1000).toFixed(1)} s, ${sb.requests.length} requêtes via net.ts${sb.logs.length ? `, ${sb.logs.length} logs` : ''}`);
  } catch (e) {
    failures++;
    console.error(`${tag} ÉCHEC: ${e instanceof Error ? e.stack : e}`);
  }
}
process.exit(failures ? 1 : 0);
