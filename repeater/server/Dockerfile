# syntax=docker/dockerfile:1

# --- build stage ---------------------------------------------------------
# Builds the `trail-stash` binary with the `live` feature (the full iroh stack). The first build
# is slow (iroh + deps); BuildKit cache mounts keep re-builds fast.
FROM rust:1-slim AS build
WORKDIR /src

# Native toolchain the iroh/rustls dependency tree needs to compile from source. If a build ever
# fails on a missing tool, it is almost always one of these.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential cmake perl pkg-config protobuf-compiler \
    && rm -rf /var/lib/apt/lists/*

COPY Cargo.toml Cargo.lock ./
COPY src ./src

RUN --mount=type=cache,target=/usr/local/cargo/registry \
    --mount=type=cache,target=/src/target \
    cargo build --release --features live --bin trail-stash \
    && cp target/release/trail-stash /trail-stash

# --- runtime stage -------------------------------------------------------
# distroless "cc" (glibc + libgcc, no shell/pkg manager) — matches the default gnu target the
# binary is linked against, minimal attack surface, non-root.
FROM gcr.io/distroless/cc-debian12:nonroot AS runtime

# OCI provenance for local/manual builds. CI (docker/metadata-action) injects source+revision on top.
LABEL org.opencontainers.image.title="trail-stash" \
      org.opencontainers.image.description="Ciphertext-blind, stateless iroh-docs replica + push waker (offline trail delivery)" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.source="https://github.com/unrealJune/trail-stash"

COPY --from=build /trail-stash /trail-stash

USER nonroot:nonroot

ENV PORT=8787
# Control API (HTTP). iroh's QUIC/relay traffic uses UDP on dynamically chosen ports and works
# through the relay without inbound exposure; publish a UDP port only if you want direct dialing.
EXPOSE 8787/tcp

ENTRYPOINT ["/trail-stash"]
