fn main() {
    // Vendored: the Kotlin half of blew lives in the IrohLocation Expo module
    // (modules/iroh-location/android/src/main/java/org/jakebot/blew), not beside this crate.
    let android_dir = std::path::Path::new(&std::env::var("CARGO_MANIFEST_DIR").unwrap())
        .join("../../../android");
    println!("cargo:android_dir={}", android_dir.display());
}
