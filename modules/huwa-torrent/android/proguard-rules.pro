# rustls-platform-verifier (Kotlin part): only called from Rust through JNI, invisible to R8.
-keep, includedescriptorclasses class org.rustls.platformverifier.** { *; }
# JNI entry points of libhuwa_torrent_core.so (Java_expo_modules_huwatorrent_HuwaTorrentNative_*).
-keep class expo.modules.huwatorrent.HuwaTorrentNative { native <methods>; }
