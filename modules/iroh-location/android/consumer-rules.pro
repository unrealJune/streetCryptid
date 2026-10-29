# Keep rules for the app's release build. Expo SDK 58 turns R8 on for release builds by default
# (`android.enableMinifyInReleaseBuilds`), and everything below is reached BY NAME from native code
# or reflection, where R8 cannot see the reference. A missing rule here does not fail the build: it
# ships an APK that dies the first time Rust calls back, or never loads the library at all.

# JNA binds the UniFFI library interface by method name and reads `Structure` fields reflectively.
-keep class com.sun.jna.** { *; }
-keep class * implements com.sun.jna.** { *; }
-dontwarn java.awt.**

# UniFFI's generated bindings: `RustBuffer` and friends are JNA `Structure`s, the FFI functions are
# looked up by symbol name, and callback vtables are invoked through JNA proxies.
-keep class uniffi.iroh_location.** { *; }

# blew (BLE pairing): the Rust crate finds these classes and their methods by name over JNI, and
# their `external` methods resolve through JNI symbols that embed the class name.
-keep class org.jakebot.blew.** { *; }
