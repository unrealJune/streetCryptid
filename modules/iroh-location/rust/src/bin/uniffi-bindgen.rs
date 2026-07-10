// UniFFI binding generator. After `cargo build`, run this to emit Swift + Kotlin:
//   cargo run --bin uniffi-bindgen -- generate --library <path-to-libiroh_location> \
//       --language swift  --out-dir ../ios/generated
//   cargo run --bin uniffi-bindgen -- generate --library <path-to-libiroh_location> \
//       --language kotlin --out-dir ../android/src/main/java
fn main() {
    uniffi::uniffi_bindgen_main()
}
