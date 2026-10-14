# Spike S2: the Huwa P2P node in a browser

Phase 0 gate for D2–D5 of `docs/WEB_DOCKER_PLAN.md`. Question: can the existing node
(`src/p2p/worklet/node.js`: Corestore 7 / Autobase / Hyperbee / Hyperswarm) run unchanged in a
browser Worker, on IndexedDB, reaching the network through a non-custodial `@hyperswarm/dht-relay`
gateway, with private keys that never leave the browser?

**Recommendation: GO for D3**, with the conditions listed at the end. Everything the plan needs
from the node worked in headless Chromium: storage, restart from IndexedDB, pairing with a phone
(`pairingInvite` / `acceptPairing`), home-base and comment replication both ways, identity creation
in the browser. The relay never received a secret. D3-F stays as the fallback, but nothing found
here calls for it. The remaining risk is connection reliability: 3 of 16 browser runs never got a
working peer connection within 30 s, and pairing takes 14–23 s on the local testnet. The details
are below.

Date: 2026-10-14 · macOS arm64 · Node 22.22.3 · Chromium 153.0.8010.12 headless (Playwright 1.63.0).
Raw numbers: `packages/rocksdb-idb/spike/results.json` (last full run).

## What was built

| Piece | Where | Role |
|---|---|---|
| Seam (own commit) | `src/p2p/worklet/node.js`, `test/p2p/seam.test.mjs` | `HuwaNode` takes `storage` (path **or** any Corestore storage), `statsStorage` (path/object/lazy function) and `swarmFactory(opts, { role })`. Defaults are unchanged, so the Bare worklet (`index.js` passes a path) behaves exactly as before. |
| `rocksdb-idb` | `packages/rocksdb-idb/{index.js,lib/}` | The part of `rocksdb-native` that hypercore-storage 3.3 uses, over in-memory sorted tables persisted in IndexedDB. |
| Gateway | `services/huwa-gateway/relay.js` | WebSocket `/p2p` → `@hyperswarm/dht-relay`, **non-custodial only**, plus signed mutable records and an audit mode. |
| Browser swarm | `packages/rocksdb-idb/spike/relay-swarm.js` | `swarmFactory` for HuwaNode: Hyperswarm over the relay client, with the stand-ins listed below. Moves to `src/p2p/web/` in P3. |
| Harness | `packages/rocksdb-idb/spike/` | `build.mjs` (esbuild), `worker.js` (real HuwaNode in a Worker), `run.mjs` (Playwright + gateway + "mobile" process), `mobile.mjs`, `node-relay-check.mjs`, `native-pair-check.mjs`, `hcs-suite.mjs`, `shims/`. |

Run it: `cd packages/rocksdb-idb && npm install && npm test && node spike/run.mjs`
(`--p2p-only` skips storage/PoW; `node spike/node-relay-check.mjs --mobile-process --runs 4` is
the same flow in Node; `node spike/hcs-suite.mjs <hypercore-storage checkout>` runs the upstream suite).

## 1. rocksdb-idb

hypercore-storage 3.3.1 calls (read from `index.js`, `lib/tx.js`, `lib/view.js`, `lib/streams.js`,
`migrations/*`):

- `new RocksDB(path, opts)` (only when given a path; in the browser the DB instance is passed in),
  `RocksDB.ColumnFamily`, `db.columnFamily(cf)`, `session()`, `snapshot()`, `close()`, `ready()`,
  `suspend()`/`resume()`, `flush()`, `compactRange()`, `path`, `opened`/`closed`;
- `read({ autoDestroy })` → `get`, `tryFlush`; `write({ autoDestroy })` → `tryPut`, `tryDelete`,
  `tryDeleteRange`, `flush`;
- `iterator({ gte, lt, reverse })` (ordered and reverse ranges, streamx Readable);
- private fields: `db._snapshot` (`snapshotted`), `db._state.closing`, `db._index` (`dbClosing`).

The adapter implements all of that, plus `put/delete/deleteRange/get/peek/keys`, limits, `gt/lte`,
and key/value encodings. Design:

- one `Table` per column family: sorted array of hex keys plus a `Map`. Lowercase hex keeps the
  bytewise order, so plain string comparison works. Values are copied on write and on read,
  because Hypercore mutates bitfield pages in place;
- write batches apply to memory synchronously (atomic) and are persisted in **one IndexedDB
  transaction per group of batches** (group commit). `deleteRange` is a single `IDBKeyRange`
  delete. There is no separate WAL: IndexedDB already is the log. Durability is `relaxed`, and a
  batch resolves when its transaction completes;
- MVCC snapshots: every live snapshot keeps an undo log of the keys changed after it was taken.
  Iterators take an implicit snapshot when they open, as RocksDB iterators do.

Not done for the spike: lazy loading (the whole DB is in RAM, loaded with `getAll` at open),
compaction (nothing to compact), and a multi-tab lock. A second tab on the same database would
diverge, so this needs D5 (SharedWorker or `navigator.locks`).

`@ohominio/rocksdb-indexdb-adapter`: **not on npm** (404). `npm search` found no browser backend
for rocksdb-native or hypercore-storage either, so the adapter was written from scratch.

**hypercore-storage's own suite** (v3.3.1 tag, brittle, in Node, `rocksdb-native` aliased to the
adapter, fake-indexeddb 6.2.5): **73/73 tests, 330 asserts pass** (atomic 8, basic 8, core 28,
groups 7, snapshot 4, streams 9, tree-cache 9). `migration.js` was skipped: it opens an on-disk
RocksDB fixture from v2, which a browser never has. The package's own tests pass too (`npm test`:
adapter semantics, Corestore/Autobase reopen, HuwaNode pairing across the adapter, sodium
cross-checks; 17/17).

## 2. Browser results (Chromium Worker)

**Bundle** (esbuild 0.25.12, minified IIFE, whole node + relay client + adapter + crypto shims):

| | raw | gzip | brotli |
|---|---|---|---|
| as shipped by the harness (English-only bip39 wordlist) | **1.24 MB** | **346 KB** | **261 KB** |
| with all 12 bip39 wordlists (stock `bip39-mnemonic`) | 2.28 MB | 531 KB | 397 KB |

Largest parts: hypercore 181 KiB, autobase 138, hypercore-storage 76, @noble/curves 62, Huwa
`src/p2p` 60, hyperbee 49, sodium-javascript 44, protomux 43, dht-relay 39.

**3a: storage** (Corestore + Autobase on rocksdb-idb, close, then a new Worker after a page reload):

| | |
|---|---|
| 500 single appends, 1 KB blocks | 1.39 s (**~360 appends/s**, about one IndexedDB transaction each) |
| one batch append of 500 blocks | 38 ms |
| Autobase (Hyperbee view), 100 appends + update | 2.3 s (**~43/s**) |
| reopen after reload (load the whole DB) | 45 ms; key, 1000 blocks and the 100 view entries read back intact |
| HuwaNode `ready()` on an existing profile after reload | 42 ms; identity and replicated profile restored |
| identity created in the browser (24-word phrase, keet-identity-key) | 148 ms |

**3c: proof of work** (blake2b-256, `src/p2p/worklet/pow.js` unchanged):

| | hashes/s | 8 bits | 12 bits | 16 bits (new author's comment) |
|---|---|---|---|---|
| Chromium Worker, sodium-javascript | 137 k | 3 ms | 23 ms | **344 ms avg**, 701 ms max (4 runs) |
| Chromium Worker, @noble/hashes | 133 k | | | |
| Node, sodium-native | 2.45 M (18×) | 0 ms | 1 ms | 15 ms |

The blake2b WASM backend does not load in the bundle (`WASM_SUPPORTED` false), so this is plain
JS. In the replication runs, posting a comment (PoW included) took 57 ms – 2.4 s; the tail comes
from the geometric distribution of PoW.

**3b: browser (relay) ↔ "mobile" (native HuwaNode, its own process, plain UDP)** on a local
HyperDHT testnet. The gateway runs in its own process:

| | last full run | over 16 browser runs |
|---|---|---|
| `acceptPairing` (same identity, mobile lists 2 devices) | 22.4 s | **16/16 paired, 13.9–22.6 s** |
| home base phone → web (profile change) | 7.8 s | 53–59 ms in 8 runs (live connection); 7.6–15 s in 4; **not within 30 s in 3/16** |
| comment web → phone (room Autobase) | 459 ms (PoW 343 ms, propagation 112 ms) | propagation 108–112 ms |
| comment phone → web (another room, discovery included) | 153 ms | 125–177 ms |

Controls, so the browser numbers can be read:

- **same flow in Node** (same relay client, same gateway, rocksdb-idb on fake-indexeddb; browser
  sodium shim or native): **11/11 OK**, pairing **77–494 ms**, home base 72–93 ms, comment
  web → phone 140 ms – 1.3 s (PoW), with the mobile in-process (4) or in its own process (7);
- **two native nodes in separate processes** (no relay): pairing **15.4–22.2 s** (7/7), home base
  50–100 ms (one run 12.8 s).

The slow pairing is therefore not caused by the relay. On this local testnet the first direct
connection between two processes fails, and blind-pairing falls back to its DHT request records,
which the member polls every 5 s. The occasional run with no working connection at all is specific
to the browser: it never happened in Node with identical code. The gateway's leg towards the mobile
reports `connection timed out` (UDX), and the cause is not identified yet. Moving the gateway into
the harness process did not change it: 4 such runs are among the 16. See the conditions below.

**3d: the relay never sees secrets.** The gateway (`--audit`) records every byte it receives from
browsers and writes a V8 heap snapshot while the browser node is connected. The harness then
searches both for the browser's swarm secret key, device secret key, box seed, Corestore primary key
and home writer secret key (raw bytes and the 32-byte seed half in the inbound stream; hex and
base64 in the heap strings):

- **no secret found** in 16 KB of inbound traffic or in the 12 MB heap snapshot;
- control: a custodial dht-relay client is **refused** (stream closed), and its secret key **is**
  found in the inbound bytes, so the detector works;
- a heap snapshot holds strings, not ArrayBuffer contents. The inbound-bytes check is the strong
  one: a secret that never crosses the wire cannot be in the gateway's memory.

What the gateway does see: public keys, topics looked up and announced (which works and rooms a
user opens), IP addresses, ciphertext. Noise runs in the browser. `SELF_HOSTING.md` should say this.

## 3. What did not work out of the box (and the fixes)

**`@hyperswarm/dht-relay` 0.4.3** (the latest release, marked experimental) against hyperdht 6.34 /
Hyperswarm 4.17 / blind-pairing 2.3. The fixes live in our code and the package is unpatched on disk:

| # | Problem | Effect | Fix (where) |
|---|---|---|---|
| 1 | `SigneeProxy` destructures `{ peer: relayAddresses }`, but hyperdht passes `ann = { peer: { publicKey, relayAddresses }, refresh }` | every **non-custodial announce** hangs, so a browser can never be found and never accepts connections (`PEER_NOT_FOUND`) | subclass swapped in before `node-proxy.js` loads (`relay.js`) |
| 2 | no `mutablePut` / `mutableGet` | blind-pairing (QR linking) cannot post or read its request records | `POST/GET /p2p/mutable`: the browser signs, the gateway verifies and stores through hyperdht's `signMutable` hook, the browser verifies reads (`relay.js`, `relay-swarm.js`) |
| 3 | `Query.finished()` only resolves after the query has been read to the end | `dht.announce(...).finished()` in blind-pairing never returns | `finished()` calls `resume()` (`relay-swarm.js`) |
| 4 | the relayed stream has no `rawStream.rtt` | blind-pairing never sends its request over an open connection | set `rtt = 0` on new connections (`relay-swarm.js`) |
| 5 | no `suspend`, `resume`, `online`, `lookupAndUnannounce` | Hyperswarm 4 calls them | stand-ins (`relay-swarm.js`) |
| 6 | custodial mode is the default and the server accepts it | a misconfigured client would hand its secret key to the server | the gateway refuses any handshake/connect/announce/unannounce carrying a secret key |

The relayed **server** path (the browser accepting connections) and the relayed client path then
both work. The client's announce signable matches hyperdht's (`refresh` is always null when
announcing).

**Browser bundle gaps** (sodium-javascript 0.8.0 is what `sodium-universal`'s browser field
selects). Each shim is checked byte for byte against sodium-native in `test/sodium-shim.test.mjs`:

- `crypto_scalarmult_ed25519_noclamp`: the Noise DH (`noise-curve-ed`), so every connection
  depends on it. Implemented with @noble/curves;
- `crypto_aead_xchacha20poly1305_ietf_*`: blind-pairing. HChaCha20 plus ChaCha20-Poly1305-IETF from
  sodium-javascript;
- `extension_pbkdf2_sha512_async`: bip39 seed. @noble/hashes;
- streaming `crypto_hash_sha512/256_{init,update,final}`: sodium-hmac, used by keet-identity-key;
- a `Buffer` polyfill (buffer 6.0.3) with b4a's Node flavour, because keet-identity-key calls
  `writeUInt32BE` on a b4a buffer;
- `setImmediate` over MessageChannel (`pow.js` yields with it), stubs for `fs` / `path` / `os` /
  `device-file`, and hyperdht's own browser stub (only `DHT.keyPair` is used).

Testnet artifact: a server on `testnet.createNode()` (host pinned to 127.0.0.1) never gets the
holepunched stream, with or without the relay. The gateway uses a plain `new DHT({ bootstrap })`.

## 4. Versions

| Package | Version | Notes |
|---|---|---|
| corestore | 7.13.0 | root |
| hypercore | 11.37.1 | root |
| hypercore-storage | 3.3.1 | root; suite run from the `v3.3.1` tag |
| rocksdb-native | 3.18.1 | mobile/Node only; replaced by rocksdb-idb in the browser |
| autobase · hyperbee | 7.28.2 · 2.27.3 | root |
| hyperswarm · hyperdht | 4.17.2 · 6.34.0 | root; the gateway uses hyperdht 6.34.0, dht-relay's client copy is 6.34.1 |
| @hyperswarm/dht-relay | **0.4.3** (pinned) | gateway + browser; needed the fixes in §3 |
| @hyperswarm/secret-stream | 6.9.2 | |
| blind-pairing · keet-identity-key | 2.3.1 · (root) | |
| sodium-universal · sodium-javascript | 5.0.1 · 0.8.0 | dht-relay brings sodium-universal 4.0.1, which maps to the same shim |
| @noble/curves · @noble/hashes | 2.4.0 · 2.4.0 | root (already app dependencies) |
| buffer | 6.0.3 | browser bundle |
| ws | 8.18.3 | gateway |
| esbuild | 0.25.12 | root devDependency |
| playwright | 1.63.0 (Chromium 153.0.8010.12) | 1.63.0 matches the cached browser build 1243 |
| fake-indexeddb · brittle · test-tmp | 6.2.5 · 4.5.0 · 1.4.0 | tests |

No change to the root `package.json`. New dependencies are in `packages/rocksdb-idb/package.json`
(devDependencies, pinned) and `services/huwa-gateway/package.json`, each with its own lockfile.

## 5. Go / no-go

**GO for D3** (browser node + non-custodial relay), because:

- the node runs **unchanged** (only the seam) on IndexedDB, survives reloads, pairs with a phone,
  and replicates the home base and rooms both ways;
- **keys stay in the browser**, which the byte and heap audit shows; custodial clients are refused;
- the bundle (346 KB gzip) and PoW (0.34 s average at 16 bits) are acceptable for a web app;
- every dht-relay gap was small and fixable at the edges. None of the fixes touch the protocol
  messages, except the new HTTP route for mutable records.

Conditions for P3 (before the web login UI ships):

1. **Fork and pin dht-relay** (`@huwa/dht-relay` or vendored under `services/huwa-gateway`), fold in
   fixes 1–6 with tests, and carry mutable records in the protocol instead of HTTP (rate-limited, ≤1 KB).
2. **Connection reliability**: find out why 3/16 browser runs had no working connection (Node with
   identical code: 0/11), then run the same harness on a real network (deployed gateway, phone on
   4G/Wi-Fi) before relying on "QR link < 20 s". Locally, pairing is 14–23 s even without the relay
   (blind-pairing's 5 s poll plus a failed first direct connection), so shorten that path: retry
   the direct connection, or poll faster while an invite is open.
3. **rocksdb-idb hardening**: multi-tab lock (SharedWorker plus `navigator.locks`, D5), lazy value
   loading or an LRU instead of the whole DB in RAM, quota and eviction handling
   (`navigator.storage.persist()`), Safari and Firefox runs (only Chromium was tested).
4. **PoW**: use a WASM blake2b (sodium-javascript's WASM path does not load in the bundle). JS is
   about 18× slower than native.
5. Keep the shims as one tested module (`src/p2p/web/`), checked against sodium-native in CI.

If condition 2 fails on a real network (connections not reliably established through the gateway),
switch to **D3-F** (linked session lite) for P3 and keep D3 for later.

## 6. Phase 3 follow-up (2026-10-14)

The conditions above were worked through in phase 3 (`docs/WEB_DOCKER_PLAN.md` P3):

1. **dht-relay forked and vendored**: `services/huwa-gateway/dht-relay/` (README lists every
   change). Mutable records now travel in the relay protocol; the HTTP `/p2p/mutable` route is gone.
2. **Cause of the "no working connection" runs found**: hyperdht runs the Noise exchange through
   several DHT nodes at once and can hand the same server reply to `recv` twice. The relay client
   threw on the duplicate; the exception escaped into the transport's `push()` and froze the read
   loop of the whole relay stream (every later connection, announce and signature request of that
   browser was dropped, hence the gateway's "connection timed out"). Fixed (duplicate denied,
   handlers can no longer freeze the stream), with tests. Two more hangs fixed: a relayed server
   re-listening with a key still closing on the gateway (`listenError` + retry), and signature
   requests sent to a client that is gone. Lookups/announces issued while the WebSocket is still
   opening now wait for it instead of ending empty (a fresh node was undiscoverable).
   **Real network** (public HyperDHT, gateway and "phone" in their own processes on one machine
   behind one NAT, Chromium 153): **20/20** QR links, median **1.8 s**, max 10.4 s (first run on a
   cold gateway), comments 0.18 s web → phone and 0.11 s phone → web
   (`packages/p2p-web/bench/results-public-chromium.json`). Not measured: a phone on 4G / another
   network.
3. **rocksdb-idb**: lazy values (LRU), WAL + compaction, coded quota errors, encryption at rest,
   single-writer Web Lock (`packages/rocksdb-idb`).
4. **PoW**: blake2b on WebAssembly in the browser shim (2.5 M hashes/s vs 3.8 M native, measured in Node's V8; in Chromium a new author's comment, 16-bit PoW included, reaches the phone in about 0.2 s).
5. Shims in `src/p2p/web/shims/`, tested against sodium-native (`packages/p2p-web/test`).
