## What's Changed in v1.1.7.1

• **Plugin Market Reverted to Settings Dialog**:
  - Reverted the standalone home and sidebar rail injections.
  - Restored the native Plugin Market tab directly inside the Settings dialog under the Server section, ensuring full stability with the SolidJS/Kobalte tabs lifecycle.

• **WebKitWebProcess SIGILL Crash Fix Maintained**:
  - Maintained runtime CPUID AVX detection (`std::is_x86_feature_detected!("avx")`) in `lib.rs`, automatically setting `JSC_useJIT=0` on non-AVX x86_64 processors (Intel Pentium N3710, Celeron) to prevent crashes.

• **Packaging & Distribution**:
  - Bumped release version to `1.1.7.1`.
  - Automated CI build producing standalone binary (`opencode-desktop`) and AppImage.

**Full Changelog**: https://github.com/tahayerd/opencode-tauri/compare/v1.1.7...v1.1.7.1
