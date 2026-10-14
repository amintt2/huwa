# @huwa/dht-relay

Vendored fork of [`@hyperswarm/dht-relay`](https://github.com/holepunchto/hyperswarm-dht-relay)
**0.4.3** (ISC, see `LICENSE`; upstream README in `README.upstream.md`), used by the Huwa gateway
(`services/huwa-gateway`) and the browser node (`src/p2p/web/`). Every change is marked
`HUWA FORK` in the code. The wire protocol is upstream's plus four messages appended at the end of
the channel (upstream message ids are unchanged).

| # | Change | Why |
|---|---|---|
| 1 | `SigneeProxy` reads `ann.peer.relayAddresses` (hyperdht 6 shape) and refuses `refresh` announces | upstream forwarded the whole peer object: every non-custodial announce hung (`PEER_NOT_FOUND`) |
| 2 | `mutablePut` / `mutableGet` messages: the client signs, the relay verifies before storing (`signMutable` hook), the client verifies reads; values ≤ 1000 bytes, rate limited | blind-pairing (QR linking) stores its requests as mutable records |
| 3 | `Query.finished()` drains the query (like hyperdht) | `dht.announce(...).finished()` without a reader hung |
| 4 | relayed streams have `rtt = 0`, `remoteHost`, `remotePort` | blind-pairing never sent its request over a relayed connection |
| 5 | client `suspend`/`resume`/`online`/`suspended`/`lookupAndUnannounce`, server `suspend`/`resume`, `destroyed` getter fixed, `close` event | Hyperswarm 4 calls them |
| 6 | client is **non-custodial by default**; `relay()` refuses any handshake / connect / listen / announce / unannounce carrying a secret key (bytes zeroed, stream destroyed) unless `allowCustodial` | a misconfigured client would hand its key to the server |
| 7 | per-client limits (`maxConnections`, `maxServers`, `maxQueries`, `mutablePerMinute`) and backpressure: UDX streams pause while the client's WebSocket is backed up | a client could make the relay buffer without bound |
| 8 | WebSocket transport: waits on `bufferedAmount`, optional `bytesPerSecond` token bucket (pauses the TCP socket inbound) | bandwidth limit per client |
| 9 | compact-encoding 3 (`optionalBuffer`), noise-handshake 4, sodium-universal 5 | same versions as the app (one copy in the browser bundle) |

```js
const RelayNode = require('@huwa/dht-relay')
const Stream = require('@huwa/dht-relay/ws')

// server (gateway)
RelayNode.relay(dht, new Stream(false, socket), { limits, onrefuse, onlimit })

// client (browser): keys stay here
const dht = new RelayNode(new Stream(true, new WebSocket(url)), { keyPair })
```

Tests: `npm install && npm test` (local HyperDHT testnet: announce signing against hyperdht 6.34,
mutable records both ways, `finished()`, `rtt`, Hyperswarm 4 over the relay, custodial refusal,
limits).
