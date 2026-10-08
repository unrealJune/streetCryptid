# Spike: `uniffi-bindgen-react-native` against `iroh-location`

Reproduces `docs/audit/ubrn-spike-2026-10-08.md` on a Linux or macOS host with Rust and bun.
Nothing here is wired into the app; it generates bindings into a scratch directory and calls
the real crate from TypeScript through the Node runtime.

```sh
# 1. a cdylib to read the UniFFI metadata from (debug is fine, ~8 min cold on 4 cores)
cd modules/iroh-location/rust && cargo build

# 2. a scratch project with the generator and the Node runtime
mkdir -p /tmp/ubrn-spike && cd /tmp/ubrn-spike && bun init -y
bun add uniffi-bindgen-react-native@0.31.0-6 @ubjs/core@0.31.0-6 @ubjs/node@0.31.0-6
bun add -d typescript @types/node
cp <repo>/scripts/spikes/ubrn/{tsconfig.json,uniffi.toml} .
mkdir spike && cp <repo>/scripts/spikes/ubrn/{call.ts,engine.ts,ubjs-node-augment.d.ts} spike/

# 3. generate (library mode reads uniffi.toml from the crate directory, and runs cargo metadata
#    from the cwd, so run it from the crate)
cp uniffi.toml <repo>/modules/iroh-location/rust/uniffi.toml   # remove afterwards
cd <repo>/modules/iroh-location/rust
/tmp/ubrn-spike/node_modules/.bin/ubrn generate napi bindings --library \
  --ts-dir /tmp/ubrn-spike/generated/napi --lib-colocated ./target/debug/libiroh_location.so
ln -s $PWD/target/debug/libiroh_location.so /tmp/ubrn-spike/generated/napi/

# 4. typecheck the generated surface, then call into Rust
cd /tmp/ubrn-spike && bunx tsc -p tsconfig.json && bun run spike/call.ts && bun run spike/engine.ts
```

The first `ubrn` invocation builds the CLI from its bundled crate with cargo (one-off).
