# SCB2 map streams

The client and `unrealJune/streetCryptid-map-server` share this additive protocol.
SCB1 `/bundle/v1` remains supported for older clients. A v2 404/405 triggers
explicit client compatibility fallback; corruption, 429, and 5xx do not.

## Privacy and request

`GET {sourceUrl}/bundle/v2/{x10}/{y10}/{tileZoom}` accepts only the fixed z10
anchor and requested data zoom (11-14). Never send a target child coordinate,
viewport, arbitrary tile list, or target-dependent order. Every stage includes
the complete deterministic descendant square, including known-empty tiles.
Coarse raw XYZ requests remain limited to z0-10.

Requests use `Accept: application/vnd.streetcryptid.tile-stream`. Responses use
that Content-Type, a strong dataset/representation-versioned ETag,
`Accept-Ranges: bytes`, and `Cache-Control: public, max-age=86400, no-transform`.
There is **no HTTP Content-Encoding**: gzip is internal to each frame so HTTP
range offsets always refer to the same encoded bytes.

## Wire format

All integers are unsigned big-endian. The header is 20 bytes:

| Offset | Bytes | Value                  |
| -----: | ----: | ---------------------- |
|      0 |     4 | ASCII `SCB2`           |
|      4 |     1 | Version `2`            |
|      5 |     1 | Fixed anchor zoom `10` |
|      6 |     1 | Requested data zoom    |
|      7 |     1 | Reserved, zero         |
|      8 |     4 | Anchor X               |
|     12 |     4 | Anchor Y               |
|     16 |     4 | Stage count            |

For z14 the stages are `[13, 14]`; other zooms have a single stage at that zoom.
Each stage frame contains:

| Bytes | Value                                          |
| ----: | ---------------------------------------------- |
|     4 | Compressed payload length                      |
|     4 | Uncompressed SCB1 length                       |
|    32 | SHA-256 of the uncompressed SCB1 bytes         |
|     N | Deterministically gzipped complete SCB1 bundle |

The contained SCB1 header specifies the actual stage zoom. Its anchor, tile
count, row-major descendants, sizes and absence of trailing bytes must validate.
Raw stages are capped at 64 MiB and compressed stages at 65 MiB. The entire
response is capped at `20 + 2 * (40 + 65 MiB)`. The expected stage count and
per-stage hashes detect truncated or corrupt responses; no incomplete stage
becomes a completed tile-cache entry.

Cold z14 generation sends and flushes the complete z13 stage before constructing
z14. The engine can paint a sharp coarse preview at the requested camera while
detail continues; the preview's data zoom remains honestly z13. The entire fixed
request continues even after the target tile appears.

## Resume and durability

The app journals transport prefixes in `streetcryptid.tile-downloads.db` in
256 KiB chunks, independently of `streetcryptid.tiles.db`. Complete validated
stages are persisted through the existing complete-bundle store. A dropped
transfer retains its incomplete transport prefix, not partially decoded tiles.

A retry sends `Range: bytes=<persisted-length>-` and `If-Range: <etag>`.

- A 206 must have the same strong ETag and an exact Content-Range starting at
  the saved byte count and ending at the representation's last byte.
- A 200 discards the old prefix before decoding the new representation.
- A 416 is accepted only with the saved ETag and
  `Content-Range: bytes */<persisted-length>`; the complete local stream must
  still validate. This handles a crash after the last journal write.
- Invalid framing/hash/range metadata discards the journal.
- Successful completion removes the transport journal.

Journals are capped at 256 MiB total and expire after 24 hours. Eviction removes
whole journals. If native SQLite is unavailable, the app warns and uses bounded
in-memory resume; across-process resume is then unavailable.

Two simultaneous v2 transfers are admitted process-wide. Headers have a
60-second deadline, each reader wait has a 45-second no-progress deadline, and a
transfer has a ten-minute total budget. Native cancellation is not awaited
unboundedly. Server cached objects support single HTTP ranges and If-Range; a
cold range request may finish generating the object before responding.

## Rollout

Deploy the server first to enable v2; old app binaries continue using v1.
New app code can also precede the deployment, but will explicitly fall back to
the old all-at-once transport. The protocol does not require a native API change;
the app uses SDK 57's named `expo/fetch`, existing Expo SQLite/Crypto, and the
small pure-JS `fflate` gzip decoder.

The hex shimmer and cold-locate zoom cap work independently of server rollout.
Uncovered destinations open no closer than z15, while covered destinations keep
their chosen zoom. Progressive/resume behavior must still be exercised on
physical iOS/Android devices under network loss before claiming device speedups.
Idle neighbor/friend warming is also capped at camera z15 so speculative work
does not fetch 256-tile detail bundles behind the foreground view.
