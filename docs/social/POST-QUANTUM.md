# streetCryptid — Post-quantum migration and export compliance

Status: **plan, rev 1.** Nothing here is implemented. Companion to
`FORWARD-SECRECY.md` (which this extends at §4.2, §4.6 and §4.7) and
`docs/mesh/DESIGN.md` §3.2.

Two requirements, deliberately kept in one document because one of them constrains
the other: we must be **export compliant**, and we want **every asymmetric primitive
to be post-quantum**. Export compliance is the urgent half and is independent of the
crypto work — it is wrong today. The PQ half is a multi-phase wire migration.

---

## 0. The export declaration is wrong today [VERIFIED — fix before the next submission]

`app.json:21` declares:

```json
"ios": { "config": { "usesNonExemptEncryption": false } }
```

That is a factual assertion to Apple, and through Apple to BIS, that this app uses
no encryption outside Apple's five exemptions. The exemptions are: encryption
provided entirely by the OS; HTTPS/TLS for the app's own transport; copy
protection; user authentication; and a small set of special cases.

streetCryptid compiles its own ChaCha20-Poly1305, HPKE (RFC 9180), a Double Ratchet
and ed25519 signatures into the binary via `modules/iroh-location`, and uses them to
encrypt **user content** — location fixes — end to end. That is none of the five.
The accurate answer is `true`.

This is not a formality. `usesNonExemptEncryption: false` suppresses the App Store
Connect follow-up questions entirely, which is why nobody has been asked for a
classification yet. It applies to **TestFlight builds too**, and per AGENTS.md
production _is_ TestFlight for us right now.

### What the correct path looks like

Flipping the flag to `true` makes App Store Connect ask for one of: a CCATS, an
approved exemption, or a **self-classification under License Exception ENC
§740.17(b)(1)**. For an app in our shape — mass-market, publicly available, using
only _published standard_ cryptography — (b)(1) self-classification is the normal
route. It requires an ERN (a one-time emailed self-classification request to BIS
and the NSA yielding an ECCN, typically 5D002) and an **annual self-classification
report** each February covering the prior calendar year.

**The PQ work does not change this classification**, and that is worth stating
explicitly because it is a plausible worry: ML-KEM and ML-DSA are FIPS 203/204, and
X25519MLKEM768 / X-Wing are published IETF specs. They are "standard cryptography"
in the EAR's sense, so they stay inside (b)(1). The thing that would push us _out_
of self-classification and into a CCATS review is inventing our own primitive —
which we must therefore not do. Our BLAKE3 `derive_key` KDF chain and the capsule
construction are compositions of published primitives, not new primitives, and the
distinction is worth preserving deliberately.

I am not qualified to file this. Two items need someone who is:

- **[LEGAL]** Confirm (b)(1) eligibility and whether the ERN has ever been filed for
  `com.unrealjune.streetcryptid`. If not, it must be before the next non-exempt
  submission.
- **[LEGAL]** Confirm the annual report obligation and who owns the February filing.

### Actions

- **[E1]** `app.json` → `"usesNonExemptEncryption": true`. One line. Blocks nothing
  technically; it just means the next submission asks the follow-up question.
- **[E2]** Answer the ASC follow-up with the ENC (b)(1) claim once **[LEGAL]** lands.
- **[E3]** Add a `## Encryption` section to the privacy policy in `docs/` naming the
  algorithms in use. Not required by BIS; it is required by honesty, and the privacy
  policy already gates the first App Store submission.
- **[E4]** Note in `AGENTS.md` that adding a _new_ primitive (as opposed to a new
  parameterisation of a published one) is an export-classification event, not just a
  crypto review.

---

## 1. What "all encryption post-quantum" actually resolves to

Three of these are already done, three are cheap, one is genuinely hard, and one is
impossible without forking iroh. Taking them in order stops us spending the hard
budget first.

| #   | Layer                     | Today                            | Quantum-relevant?                                       | Phase  |
| --- | ------------------------- | -------------------------------- | ------------------------------------------------------- | ------ |
| 1   | Payload AEAD              | ChaCha20-Poly1305, 256-bit       | **No** — Grover halves to ~128-bit, which is the target | —      |
| 2   | KDF chain                 | BLAKE3 `derive_key`              | **No** — 256-bit output, Grover-adequate                | —      |
| 3   | v3 per-recipient wrap     | AEAD under a ratchet message key | **No** — symmetric already                              | —      |
| 4   | Pairing bump → `RK₀`      | X25519 ephemeral↔ephemeral       | **Yes, and it is the whole tree**                       | **P1** |
| 5   | v2 HPKE wrap (still live) | DHKEM(X25519, HKDF-SHA256)       | **Yes**                                                 | **P2** |
| 6   | Mesh capsule              | raw X25519 DH                    | **Yes**                                                 | **P2** |
| 7   | DH ratchet step           | X25519 per step                  | Yes — but see §3                                        | **P3** |
| 8   | Envelope signatures       | ed25519                          | Yes, but **not harvestable**                            | **P4** |
| 9   | QUIC handshake            | rustls + `ring`, X25519          | Yes, but transport-only                                 | **P5** |
| 10  | iroh node identity        | ed25519, structural              | Yes — **blocked**, see §2                               | —      |

Rows 1–3 are not a gap. Symmetric primitives at 256-bit are the recommended
post-quantum posture; there is nothing to migrate and no version of this work that
touches them.

**The single most valuable change in this table is row 4**, and it is also one of
the cheapest. Because v3 already moved the per-message wrap to symmetric
(`FORWARD-SECRECY.md` §4.7), the entire ratchet tree for a friendship hangs off one
X25519 ephemeral-ephemeral DH performed once, at pairing, in the foreground, with
both humans present. Make that one exchange hybrid and every envelope sealed under
that session for the life of the friendship becomes harvest-now-decrypt-later
resistant — without adding a single byte to any envelope. This is precisely the
PQXDH trade, and it is the reason Signal shipped PQXDH years before a PQ ratchet.

---

## 2. Hard constraint: iroh's identity is ed25519 by construction [VERIFIED]

`iroh-base` 1.0.2 depends on `ed25519-dalek`; `EndpointId` **is** an ed25519 public
key. `crypto.rs:88` carries that same key as the envelope `author`, and
`verify_v3` verifies against it. Our identity, our dial address, our signature key
and our pairing signature key are one key, and its type is chosen by iroh.

So **row 10 cannot be made post-quantum**, and row 8 can only be made PQ _additively_
— an ML-DSA signature carried alongside the ed25519 one, over the same signing
bytes, with ed25519 retained because iroh needs it to dial at all. "Every algorithm
is post-quantum" is therefore not reachable while we are on iroh; the honest target
is **every algorithm whose break would retroactively expose user location data**,
which is rows 4–7, plus additive PQ authentication in row 8.

That is not a small asterisk and it should not be buried. If pure-PQ identity is a
hard requirement rather than a preference, the conversation is about forking or
replacing iroh, and that is a different project than this one.

---

## 3. Hard constraint: the DH ratchet step is the expensive one, and the cost is bytes, not build time

Slower builds were pre-authorised, and for rows 4, 5, 6, 8 and 9 build time really is
the only cost. Row 7 is different, and the difference matters enough to state
plainly before anyone starts: **the cost of a post-quantum ratchet step is wire
bytes on a radio link, not CPU or compile time.**

Today `RatchetHeader.sender_ratchet_pub` is 32 bytes and rides in **every wrap of
every envelope**, because ratchet keypairs are per-pair. Make the ratchet step
hybrid and that field becomes an X-Wing / ML-KEM-768 public key plus a
ciphertext — order 1.1–1.2 KB, per wrap, per envelope.

Against the measured budgets:

- `docs/mesh/DESIGN.md:367` sizes a capsule at **200–400 B**, at ~5 recipients.
  Per-message PQ ratchet material takes that to roughly 6 KB — 15–30×.
- The radio frame at `DESIGN.md:214` fragments with `u8 idx, u8 total`. A 6 KB
  capsule is not a tuning problem for that framing, it is outside it.
- `pad.rs` pads payloads to `PADDED_LEN = 64` so null and real fixes are
  indistinguishable. A kilobyte-scale variable-size header sitting next to a
  64-byte constant-size payload undoes a traffic-analysis property §4.7 was
  written to buy.

This is the problem Signal spent years on and solved with erasure-coded chunking
(SPQR), spreading one KEM transmission across many messages. We should not invent
our own answer to it, and we should not pay it before rows 4–6 are done.

**Recommended resolution for row 7: PQ re-key at epoch boundaries, not per message.**
The ratchet header already carries an `epoch i` (§4.7). Carry hybrid KEM material
only on an epoch change, keep the per-message step X25519, and choose the epoch
cadence from telemetry rather than by guess. That bounds the cost to one ~1.2 KB
transmission per epoch instead of per message, keeps the mesh capsule inside its
framing between epochs, and degrades gracefully: the property lost relative to a
full PQ ratchet is post-compromise security against a quantum adversary _within_
an epoch — and `FORWARD-SECRECY.md` §1 already puts PCS explicitly out of scope,
on the grounds that a seized device never ratchets again.

Deferred decision, to be made with P3 and not before: whether the mesh path takes
the PQ epoch re-key at all, or stays classical with that stated as a §1.1 residual
risk. The mesh is the tightest budget and the least archived path.

---

## 4. Crate choice

Pure-Rust and portable, because the same envelope bytes must be produced by
`modules/iroh-location/rust` (Android NDK cross-build, iOS XCFramework) **and** by
`modules/iroh-location/rust-wasm` (`wasm32-unknown-unknown`), and those two crates
already share the ratchet source by `#[path]`. A C/asm dependency here buys speed we
do not need and costs us the cross-target story plus a cmake dependency in a build
we just spent real effort profiling.

- **`ml-kem` 0.3.2** (RustCrypto) — FIPS 203. Pure Rust, `no_std`, portable.
- **`x-wing` 0.1.0** — the X25519 + ML-KEM-768 hybrid, if we want it packaged
  rather than composed by hand.
- **`hpke` 0.14.1** — adds X-Wing and pure-ML-KEM KEMs; row 5 becomes a type
  parameter swap, since `single_shot_seal::<HpkeAead, HpkeKdf, HpkeKem, _>` is
  already generic over the KEM. Note 0.14 is a breaking bump from our 0.12
  (edition 2024, MSRV 1.85, `*_with_rng` renames, `generic-array` → `hybrid-array`).
- **`ml-dsa` 0.1.1** — FIPS 204, for P4. Version 0.1.x; treat as the least mature
  of these and the least urgent.

Explicitly **hybrid, not pure-PQ**, everywhere: X25519 ‖ ML-KEM-768 with both
secrets fed into the same KDF, so the construction is no weaker than the stronger
half. ML-KEM's cryptanalysis is young compared to X25519's, and a pure-PQ switch
converts a future ML-KEM result from "inconvenient" into "retroactively fatal."
This matches IETF/X-Wing practice. Pure-PQ (the CNSA 2.0 posture) remains a KEM
type swap away if that requirement ever lands, and P1's suite negotiation is what
makes that swap cheap later.

---

## 5. Phases

Each phase is independently shippable and independently valuable. P1 is the one
that matters; P4 and P5 are completeness.

### P1 — Hybrid pairing handshake (PQXDH-equivalent) — **do this one**

Make `RK₀` depend on a hybrid secret.

- `pairing.rs`: alongside the existing 32-byte X25519 ratchet ephemeral, exchange an
  ML-KEM-768 encapsulation key and ciphertext. Both sides' contributions are already
  committed at `Hello` and folded into the SAS transcript (`sas_record`) — the PQ
  material must go into **both**, or a MITM can swap the PQ half without changing
  the figure the humans compare.
- `lib.rs:4347` `derive_boot_root`: `RK₀ = KDF_boot(ss_x25519 ‖ ss_mlkem ‖ transcript)`.
  Concatenate into the existing BLAKE3 `derive_key`; do not replace the X25519 input.
- **Wire break.** Per AGENTS.md, `PairMsg` is ed25519-signed over a re-encode of the
  _decoded_ struct, so appending a field is breaking however tolerant postcard is.
  **Bump `PAIR_ALPN` to `streetcryptid/pair/5`**, not just `PAIR_WIRE_V`, so a
  version mismatch fails at ALPN negotiation rather than surfacing as "your friend's
  phone refused the pair."
- Carry a **suite id** in the handshake rather than hardcoding the KEM, so P3 and any
  future parameter change negotiate instead of re-breaking the ALPN.
- Size: ~1.2 KB once per pairing, on a foreground BLE/iroh handshake where the
  humans are already waiting on a SAS comparison. Note the pairing-latency work in
  `f1f4da0` and re-run `pair-bench` after.
- **Zero bytes added to any envelope.** Every session paired after P1 is
  harvest-now-decrypt-later resistant for its entire life.
- Existing pairings keep their classical `RK₀`. Re-pair is the only upgrade path;
  decide whether to surface that in the UI or leave it silent.

### P2 — Hybrid HPKE wrap and mesh capsule

- `crypto.rs` row 5: swap `HpkeKem` to X-Wing after the `hpke` 0.12 → 0.14 bump.
  **`crypto::seal` (v2) is still called from production paths** — `lib.rs:603`,
  `658`, `1459`, `2400` — so this is live code, not legacy cleanup. Alternative
  worth pricing first: retire the v2 path entirely and always establish a ratchet
  session, which deletes row 5 instead of migrating it.
- `mesh.rs` row 6: hybrid DH for the capsule key. Costs ~1.1 KB per capsule at the
  _epoch_ level, which is how `mesh_epoch` already works — not per fix.
- Envelope version → v4, or a new wrap variant under the existing version byte.

### P3 — Epoch-level PQ ratchet re-key

Per §3. Gate on telemetry for the epoch cadence. Decide the mesh question here.

### P4 — Additive ML-DSA signatures

An ML-DSA signature beside the ed25519 one over the same `signing_bytes_v3`.
ed25519 stays (§2). Lowest priority: signature forgery needs a quantum computer
_at forgery time_ and is not harvestable, and ML-DSA-44 takes a signature from
64 B to ~2.4 KB in an envelope budgeted at 64. Likely wants the P3 chunking answer
first.

### P5 — Hybrid QUIC handshake

`iroh` feature `tls-ring` → `tls-aws-lc-rs` for rustls's X25519MLKEM768. Cheap in
code, real in build cost (aws-lc-rs is C + asm + cmake, on NDK cross-builds and the
iOS XCFramework). Low security value for us — the stash is ciphertext-blind by
design, so the transport hop is not where the secrets are. Included for row-9
completeness, and it is the one place the pre-authorised "builds get slower" is the
actual and only cost.

---

## 6. Test obligations

Non-negotiable, because two crates must produce byte-identical envelopes:

- **Cross-crate vectors.** `tests/mesh_vectors.rs` already reads a cross-language
  fixture; extend the same pattern to the hybrid handshake and every new wrap, and
  run it in the wasm crate too. Mobile and wasm disagreeing by one byte means a web
  peer silently cannot talk to a phone.
- **Negotiation tests.** A v4-suite phone and a v5-suite phone must fail at ALPN with
  a legible error, not mid-handshake.
- **`pair-bench`** before and after P1.
- **Size assertions** on capsule and envelope bytes, so a future change cannot
  quietly walk past the `DESIGN.md:367` budget the way §3 describes.
- **KAT vectors** from FIPS 203 for whichever ML-KEM implementation we take.

---

## 7. Open questions

1. **[LEGAL]** ERN filed? Annual report owner? (§0)
2. Is pure-PQ identity a requirement or a preference? It decides whether §2 is an
   accepted limitation or a reason to leave iroh.
3. Does the mesh path take the PQ epoch re-key, or stay classical as a stated §1.1
   residual? (§3)
4. Retire the v2 HPKE path rather than migrate it? (P2)
5. Is silent re-pair acceptable as the P1 upgrade path, or does an existing
   friendship need to surface "this pairing predates PQ"?
